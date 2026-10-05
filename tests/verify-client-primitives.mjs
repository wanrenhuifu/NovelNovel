/**
 * 校验客户端半边从首方组件库 import 的**每个名字都真实存在**。
 *
 * 为什么必须单独有这条：这些名字写在 `src/client/env.d.ts` 的**手写声明**里，
 * 名字写错时 `tsc` 和产物冒烟测试都拦不住（测试用的是自造桩），
 * 而浏览器里会拿到 `undefined` 当组件用 → 整棵 React 树抛错 → **页面崩掉**。
 * 真实事故：用了 `IconFolderRegular`，而组件库里只有 `IconFolderOpenRegular`。
 *
 * 权威名单来自**安装里的真实产物**。必须用 DSH 自带的 Electron Node 运行
 * （asar 里的文件只有带 asar 支持的进程读得到），所以由
 * scripts/verify-client-primitives.mjs 启动，不要直接 node 跑。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail: ok ? undefined : detail });

// ── 1. 抓出源码里从 primitives import 的所有名字 ─────────────────
const clientDir = join(repo, "src", "client");
const sources = readdirSync(clientDir)
  .filter((f) => /\.tsx?$/.test(f))
  .map((f) => ({ name: f, text: readFileSync(join(clientDir, f), "utf8") }));

const imported = new Map();
const importRe = /import\s*(?:type\s*)?\{([^}]+)\}\s*from\s*["']@deepseek-ai\/dsh-client-ui-primitives["']/g;
for (const { name, text } of sources) {
  let m;
  while ((m = importRe.exec(text)) !== null) {
    for (const raw of m[1].split(",")) {
      const id = raw.trim().split(/\s+as\s+/)[0].trim();
      if (id !== "") imported.set(id, name);
    }
  }
}
check("源码里确实 import 了 primitives", imported.size > 0, `解析到 ${String(imported.size)} 个`);

// ── 2. 读真实产物的导出名单（靠 Electron 的 asar 支持）───────────
const install = process.env.DSH_INSTALL ?? "D:/DSH";
const pkgRoot = join(install, "resources", "app.asar", "dsh", "node_modules", "@deepseek-ai", "dsh-client-ui-primitives");

let exported = new Set();
try {
  const manifest = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
  const entry = typeof manifest.exports?.["."] === "string"
    ? manifest.exports["."]
    : (manifest.exports?.["."]?.default ?? manifest.main ?? "lib/index.js");
  const text = readFileSync(join(pkgRoot, entry), "utf8");
  const blocks = [...text.matchAll(/export\s*\{([^}]{0,80000})\}/g)].map((m) => m[1]);
  for (const block of blocks) {
    for (const part of block.split(",")) {
      const cleaned = part.trim().split(/\s+as\s+/).pop().trim();
      if (cleaned !== "") exported.add(cleaned);
    }
  }
  console.log(`primitives 产物: ${entry}（${String(text.length)} 字符，${String(exported.size)} 个导出）`);
} catch (error) {
  check("能读到 primitives 的真实产物", false, String(error.message).split("\n")[0]);
}
check("导出名单可解析（打包形态未变）", exported.size > 100, `只解析到 ${String(exported.size)} 个`);

// ── 3. 逐个核对 ────────────────────────────────────────────────
for (const [name, file] of imported) {
  check(`primitives 导出存在：${name}`, exported.has(name), `${file} import 了它，但安装里的组件库没有这个导出`);
}

const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? "✓" : "✗"} ${c.name}${c.detail === undefined ? "" : `  (${c.detail})`}`);
console.log(
  `\n${failed.length === 0 ? "全部通过" : `${String(failed.length)} 项失败`}：${String(checks.length)} 项检查` +
    `（import ${String(imported.size)} 个名字 / 库有 ${String(exported.size)} 个导出）`,
);
process.exit(failed.length === 0 ? 0 : 1);
