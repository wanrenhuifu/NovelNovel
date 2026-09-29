// 性能探针：3 部作品 × 200 章（每章 2000 汉字），打印每个工具调用的耗时与 ctx.fs 调用次数。
// harness 包由 tests/harness-loader.mjs 统一解析到运行中的 DSH 安装（见该文件说明）。
//   npm run test:dsh 的环境下运行：
//   <DSH 安装>\DeepSeek Harness.exe  <仓库>/tests/perf-probe.mjs   （ELECTRON_RUN_AS_NODE=1）
// PLUGIN_PATH 可直接指向某个 bundle 文件（用于对比旧路径变体）。
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { load, registerHarnessHook } from "./harness-loader.mjs";

registerHarnessHook(fileURLToPath(new URL("..", import.meta.url)));

const loadPlugin = async () =>
  process.env.PLUGIN_PATH
    ? import(pathToFileURL(process.env.PLUGIN_PATH).href)
    : load("dsh-novelnovel");
const { Context } = await load("@deepseek-ai/cordis");
const { default: SystemPrompt } = await load("@deepseek-ai/dsh-system-prompt");
const { default: ToolRuntime } = await load("@deepseek-ai/dsh-tools");
const { default: LocalFileSystem } = await load("@deepseek-ai/dsh-fs-local");
const plugin = await loadPlugin();

const ws = mkdtempSync(join(tmpdir(), "nn-perf-"));
const ctx = new Context();
await ctx.plugin(SystemPrompt);
await ctx.plugin(ToolRuntime);
await ctx.plugin(LocalFileSystem, { cwd: ws });
await ctx.plugin(plugin, { dataDir: ".novelnovel" });

// 统计 ctx.fs 调用次数（包装服务实例的方法，原型方法被自有属性遮蔽）
let fsCalls = 0;
const fsService = ctx.fs;
for (const method of ["resolve", "stat", "readText", "streamText", "readBytes", "listDir", "writeText"]) {
  const original = fsService[method].bind(fsService);
  fsService[method] = (...args) => {
    fsCalls += 1;
    return original(...args);
  };
}

const exec = (name, args) => ({
  callId: `c_${name}`,
  rootCallId: `c_${name}`,
  name,
  arguments: args,
  signal: new AbortController().signal,
  token: Symbol("t"),
  agent: { id: "a", session: { header: { cwd: ws } } },
  deferContext() {},
  concludeTurn() {},
});
const call = (name, args) => ctx.tools.get(name).execute(args, exec(name, args));

// 直接铺 3 部 × 200 章，跳过工具调用本身的开销
const body = "夜".repeat(2000);
for (let p = 1; p <= 3; p++) {
  const dir = join(ws, ".novelnovel", "projects", `p${p}`);
  mkdirSync(join(dir, "chapters"), { recursive: true });
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({ id: `p${p}`, title: `书${p}`, synopsis: "", worldbuilding: "设定", authorNote: "", createdAt: p, updatedAt: p }),
  );
  const items = [];
  for (let c = 0; c < 200; c++) {
    writeFileSync(join(dir, "chapters", `c${c}.md`), body, "utf8");
    items.push({ id: `c${c}`, title: `第${c + 1}章`, tags: [], sortOrder: c, updatedAt: Date.now() });
  }
  writeFileSync(join(dir, "chapters", "index.json"), JSON.stringify({ items }));
}
writeFileSync(
  join(ws, ".novelnovel", "workspace.json"),
  JSON.stringify({ version: 1, activeProject: "p2" }),
  "utf8",
);

const cases = [
  ["novel_chapter action=append chapter=150 project=p2", () => call("novel_chapter", { action: "append", chapter: "第150章", project: "p2", text: "续写一句。" })],
  ["novel_project action=list", () => call("novel_project", { action: "list" })],
  ["novel_chapter action=list project=p2", () => call("novel_chapter", { action: "list", project: "p2" })],
  ["novel_context chapter=第150章 project=p2", () => call("novel_context", { chapter: "第150章", project: "p2" })],
  ["novel_chapter action=search project=p2", () => call("novel_chapter", { action: "search", query: "夜", project: "p2", limit: 20 })],
  ["novel_lorebook action=add project=p2", () => call("novel_lorebook", { action: "add", project: "p2", name: `词条${Date.now()}`, content: "内容" })],
];

for (const [label, fn] of cases) {
  const callsBefore = fsCalls;
  const t0 = Date.now();
  await fn();
  const ms = Date.now() - t0;
  console.log(`${String(ms).padStart(5)}ms  ${String(fsCalls - callsBefore).padStart(5)} 次 ctx.fs 调用  ${label}`);
}
