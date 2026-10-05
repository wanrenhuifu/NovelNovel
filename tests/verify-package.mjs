/**
 * 分发产物冒烟：**从 npm tarball 解出来的**包能不能真的加载并注册自带技能。
 *
 * 为什么需要：README 承诺的安装路径是 `npm pack` → `dsh plugin add <tarball>`，
 * 而技能是用 `import.meta.url` 上溯到包根的 `skills/` 定位的——装进 node_modules 的形态
 * 与 `link:` 安装不同，此前**从没验证过**。这条把「打包 → 解包 → 加载 → 技能注册」走一遍。
 *
 * 必须用 DSH 自带的 Electron Node 运行。
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { load, registerHarnessHook } from "./harness-loader.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
registerHarnessHook(repo);

let passed = 0;
let failed = 0;
const check = (label, ok, extra = "") => {
  if (ok) {
    passed++;
    console.log(`✓ ${label}${extra ? `  ${extra}` : ""}`);
  } else {
    failed++;
    console.log(`✗ ${label}${extra ? `  ${extra}` : ""}`);
  }
};

// ── 1. 打包（prepack 会自动 build）──────────────────────────────────
const packDir = mkdtempSync(join(tmpdir(), "nn-pack-"));
const packed = execFileSync("npm", ["pack", "--pack-destination", packDir], {
  cwd: repo,
  encoding: "utf8",
  shell: process.platform === "win32",
}).trim();
const tarball = join(packDir, packed.split(/\r?\n/).pop().trim());
check("npm pack 产出 tarball", readFileSync(tarball).length > 0, tarball.split(/[\\/]/).pop());

// ── 2. 解包（模拟 node_modules 里的安装形态）────────────────────────
const extractDir = mkdtempSync(join(tmpdir(), "nn-unpack-"));
execFileSync("tar", ["-xzf", tarball, "-C", extractDir], { shell: process.platform === "win32" });
const pkgDir = join(extractDir, "package");
const files = readdirSync(pkgDir);
check("解出来的包含 lib/", files.includes("lib"));
check("解出来的包含 skills/", files.includes("skills"));
check("解出来的包含 cordis.patch.yml", files.includes("cordis.patch.yml"));

const skillDirs = readdirSync(join(pkgDir, "skills"));
check("自带技能目录数 = 6", skillDirs.length === 6, skillDirs.sort().join(", "));

const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const clientEntry = join(pkgDir, manifest.exports["./client"]);
check("manifest 里 client 产物存在", readFileSync(clientEntry).length > 0, manifest.exports["./client"]);
check(
  "client 产物形态正确（__ModuleLoader__ 包装 + 导出 apply/inject）",
  (() => {
    const text = readFileSync(clientEntry, "utf8");
    // cjs 形态是 `__export(index_exports, { apply: () => apply })` + `module.exports = __toCommonJS(...)`，
    // 运行期等价于 exports.apply——所以这里按**导出名**断言，不按字面写法。
    return (
      text.includes("__ModuleLoader__.load(") &&
      text.includes("module.exports = __toCommonJS(") &&
      /apply:\s*\(\)\s*=>/.test(text) &&
      /inject:\s*\(\)\s*=>/.test(text)
    );
  })(),
);

// ── 3. 加载**解出来的副本**，验证技能真能注册 ───────────────────────
// 先把它声明的运行时依赖就位（真实安装时由 npm 装进 node_modules）：
// `@lenml/char-card-reader` 是 dependencies，产物里是 external，缺了会 import 失败。
const nmDir = join(pkgDir, "node_modules");
mkdirSync(join(nmDir, "@lenml"), { recursive: true });
cpSync(join(repo, "node_modules", "@lenml", "char-card-reader"), join(nmDir, "@lenml", "char-card-reader"), {
  recursive: true,
});

const { Context } = await load("@deepseek-ai/cordis");
const { default: SkillRegistry } = await load("@deepseek-ai/dsh-skill");
const { default: SystemPrompt } = await load("@deepseek-ai/dsh-system-prompt");
const { default: ToolRuntime } = await load("@deepseek-ai/dsh-tools");
const { default: LocalFileSystem } = await load("@deepseek-ai/dsh-fs-local");

const workspace = mkdtempSync(join(tmpdir(), "nn-packws-"));
const ctx = new Context();
await ctx.plugin(SystemPrompt);
await ctx.plugin(ToolRuntime);
await ctx.plugin(LocalFileSystem, { cwd: workspace });
await ctx.plugin(SkillRegistry);

const plugin = await import(pathToFileURL(join(pkgDir, "lib", "index.js")).href);
await ctx.plugin(plugin);
await new Promise((resolve) => setTimeout(resolve, 300));

const registered = (await ctx.skills.list()).filter((skill) => skill.name.startsWith("novel"));
check("从解包副本注册的技能数 = 6", registered.length === 6, registered.map((s) => s.name).sort().join(", "));
for (const name of [
  "novel-prose",
  "novel-dialogue",
  "novel-scene",
  "novel-outline",
  "novel-cards",
  "novel-writing",
]) {
  check(`技能 ${name} 已注册`, registered.some((skill) => skill.name === name));
}

// 工具也要跟着注册（证明解包副本整体可用，不只是技能）
const toolNames = ctx.tools
  .schemas()
  .map((schema) => schema.name)
  .filter((name) => name.startsWith("novel_"));
check("从解包副本注册的工具数 = 8", toolNames.length === 8, toolNames.sort().join(", "));

rmSync(packDir, { recursive: true, force: true });
rmSync(extractDir, { recursive: true, force: true });
rmSync(workspace, { recursive: true, force: true });

console.log(`\n${failed === 0 ? "全部通过" : `${String(failed)} 项失败`}：${String(passed + failed)} 项检查`);
process.exit(failed === 0 ? 0 : 1);
