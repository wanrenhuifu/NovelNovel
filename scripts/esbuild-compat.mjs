/**
 * esbuild 的兼容入口：**先试 JS API，受限沙箱下自动退回 CLI**。
 *
 * 为什么需要这一层：JS API 通过一个**命名管道**跟自己的服务子进程通信（`spawn` 默认
 * `stdio: "pipe"`）。在文件沙箱里那个 spawn 直接 `EPERM`（`Error: spawn EPERM`，
 * `code: "EPERM"`），于是 `npm run build` 与所有纯逻辑单测（它们都要先打包 src/）全线跑不起来。
 * 而**直接执行 esbuild 自带的可执行文件是可以的**——它不是管道，只是写文件。
 *
 * 两条必须守住的约束：
 * - **只翻译本文件列出的选项**，遇到没翻译的键直接抛错。宁可显式失败，也不要悄悄产出一份
 *   与 JS API 不同的产物（产物错了，后面所有测试都在测错的东西）。
 * - **子进程只在工作区内写文件**：CLI 一律写到仓库里的 `.nn-build/`（gitignore），再由图个
 *   进程用 `node:fs` 复制到调用方要的位置。受限环境下子进程写工作区外会报 `Access is denied`
 *   （`bundle-source.mjs` 早就踩过这条），而同一个路径 node:fs 写得进去。
 *
 * 因此产物字节与 JS API 一致：同一份 esbuild 二进制、同一组选项，只是驱动方式不同。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const scratchRoot = join(packageDir, ".nn-build");

/** 已翻译的选项；出现别的键就抛错，见文件头第二条约束 */
const SUPPORTED = new Set([
  "entryPoints",
  "stdin",
  "outfile",
  "bundle",
  "format",
  "platform",
  "target",
  "external",
  "jsx",
  "alias",
  "define",
  "loader",
  "banner",
  "footer",
  "legalComments",
  "logLevel",
  "minify",
  "keepNames",
  "sourcemap",
  "write",
  "absWorkingDir",
]);

let counter = 0;

/**
 * 沙箱拒绝 spawn 的表现。只认这一种：别的错误（语法错、解析不到模块）必须原样抛出去，
 * 退回 CLI 会把真正的错误信息换成一份更难懂的失败。
 */
function isSpawnDenied(error) {
  const code = error?.code;
  const detail = `${error?.message ?? ""} ${error?.stack ?? ""}`;
  return code === "EPERM" || /spawn EPERM/.test(detail);
}

/** esbuild 自带的可执行文件：从 node_modules/@esbuild 里挑当前平台那一份 */
function cliBinary() {
  const dir = join(packageDir, "node_modules", "@esbuild");
  if (!existsSync(dir)) {
    throw new Error(`esbuild CLI fallback: ${dir} is missing; run npm install`);
  }
  const wanted = `${process.platform}-${process.arch}`;
  const found = readdirSync(dir);
  const name = found.includes(wanted) ? wanted : found[0];
  const bin = process.platform === "win32" ? "esbuild.exe" : "bin/esbuild";
  const path = join(dir, name, bin);
  if (!name || !existsSync(path)) {
    throw new Error(`esbuild CLI fallback: no binary for ${wanted} under ${dir} (saw ${found.join(", ")})`);
  }
  return path;
}

/** 选项对象 → argv。数组值展开成重复的开关；对象值展开成 `--k:a=b` */
function toArgs(options, outFile) {
  const unknown = Object.keys(options).filter((key) => !SUPPORTED.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `esbuild CLI fallback does not translate: ${unknown.join(", ")} — add it to scripts/esbuild-compat.mjs`,
    );
  }
  const args = [];
  // esbuild 的 CLI 有三类开关，分隔符不能混：单值用 `=`，可重复/映射用 `:`。
  // 写错的表现是 `Invalid build flag: "--format:esm"`。
  const value = (name, v) => {
    if (v === undefined || v === false) return;
    args.push(`--${name}=${v}`);
  };
  const list = (name, v) => {
    for (const item of v) args.push(`--${name}:${item}`);
  };
  const pairs = (name, v) => {
    for (const [k, item] of Object.entries(v)) args.push(`--${name}:${k}=${item}`);
  };
  if (options.bundle) args.push("--bundle");
  value("format", options.format);
  value("platform", options.platform);
  value("target", options.target);
  value("jsx", options.jsx);
  value("legal-comments", options.legalComments);
  value("log-level", options.logLevel);
  value("sourcemap", options.sourcemap);
  if (options.external) list("external", options.external);
  if (options.alias) pairs("alias", options.alias);
  if (options.define) pairs("define", options.define);
  if (options.loader) pairs("loader", options.loader);
  // banner/footer 是 `{ js: "…" }` 形状；CLI 要的是 `--banner:js=…`
  if (options.banner) pairs("banner", options.banner);
  if (options.footer) pairs("footer", options.footer);
  if (options.minify) args.push("--minify");
  if (options.keepNames) args.push("--keep-names");
  args.push(`--outfile=${outFile}`);
  return args;
}

/** stdin 入口：CLI 不认内存里的虚拟文件，得先落一个真文件——**落在 resolveDir 里**，
 *  否则 `./src/…` 这类相对导入会相对错目录解析。用完即删。 */
function materializeStdin(stdin) {
  if (stdin.file) return { path: stdin.file, cleanup: null };
  const resolveDir = stdin.resolveDir ?? packageDir;
  const ext = { ts: ".ts", tsx: ".tsx", js: ".js", jsx: ".jsx", css: ".css", json: ".json" }[stdin.loader ?? "js"];
  if (!ext) throw new Error(`esbuild CLI fallback: unsupported stdin loader ${stdin.loader}`);
  const path = join(resolveDir, `.nn-stdin-${process.pid}-${counter}${ext}`);
  writeFileSync(path, stdin.contents, "utf8");
  return { path, cleanup: () => rmSync(path, { force: true }) };
}

function buildViaCli(options) {
  const scratch = join(scratchRoot, `b${process.pid}-${counter++}`);
  mkdirSync(scratch, { recursive: true });
  const cleanups = [() => rmSync(scratch, { recursive: true, force: true })];
  try {
    // 出口一律落在工作区里，再由本进程复制出去（见文件头第二条约束）
    const cliOut = join(scratch, "out.js");
    const args = toArgs(options, cliOut);
    if (options.stdin) {
      const entry = materializeStdin(options.stdin);
      if (entry.cleanup) cleanups.push(entry.cleanup);
      args.push(entry.path);
    } else {
      for (const entry of options.entryPoints ?? []) args.push(entry);
    }
    const run = spawnSync(cliBinary(), args, {
      cwd: options.absWorkingDir ?? packageDir,
      // 管道在沙箱里开不了；CLI 的日志直接接本进程的 stdout/stderr
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
    });
    if (run.error) throw run.error;
    if (run.status !== 0) {
      throw new Error(`esbuild CLI fallback failed with exit code ${run.status}`);
    }
    const text = readFileSync(cliOut, "utf8");
    // `write: false` 时 JS API 也不落盘，这里不能替它落
    if (options.outfile && options.write !== false) writeFileSync(options.outfile, text, "utf8");
    // 与 JS API 的 `write: false` 同形：调用方自己决定落到哪
    return options.write === false ? { outputFiles: [{ path: options.outfile ?? cliOut, text }] } : {};
  } finally {
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch {
        // 清理失败不该掩盖真正的错误
      }
    }
  }
}

/**
 * `esbuild.build` 的同形替身。正常环境下行为与 esbuild 完全一致（JS API 直接成功），
 * 只有 spawn 被沙箱拒绝时才走 CLI。
 */
export async function build(options) {
  try {
    return await esbuild.build(options);
  } catch (error) {
    if (!isSpawnDenied(error)) throw error;
    return buildViaCli(options);
  }
}

export default { build };
