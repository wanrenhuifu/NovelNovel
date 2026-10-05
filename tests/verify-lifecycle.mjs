/**
 * 插件卸载（dispose）是否干净：`index.ts` 声称"全部通过 ctx 注册，插件卸载时由 Cordis 自动撤销"。
 *
 * 为什么这条很要紧：`npm run test:lifecycle` 已经证明**重复挂载会抛
 * `tool "novel_project" is already registered`**。所以卸载只要漏掉任何一处（工具、技能、命令、
 * 系统提示词段），HMR 重挂就会撞上自己上次留下的残留而**整块加载失败**——用户看到的是"插件坏了"，
 * 而根因是"卸载不干净"。
 *
 * 手法：在**子 fiber**（`ctx.plugin` 返回的 scope）里挂插件，然后 dispose 那个 scope，
 * 数一遍各处注册表是否回到挂载前。
 *
 * 必须用 DSH 自带的 Electron Node 运行。
 */
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { load, registerHarnessHook } from "./harness-loader.mjs";

registerHarnessHook(fileURLToPath(new URL("..", import.meta.url)));

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

const { Context } = await load("@deepseek-ai/cordis");
const { default: SystemPrompt } = await load("@deepseek-ai/dsh-system-prompt");
const { default: ToolRuntime } = await load("@deepseek-ai/dsh-tools");
const { default: LocalFileSystem } = await load("@deepseek-ai/dsh-fs-local");
const { default: SkillRegistry } = await load("@deepseek-ai/dsh-skill");
const { default: Commands } = await load("@deepseek-ai/dsh-commands");
const { default: SandboxPolicy } = await load("@deepseek-ai/dsh-sandbox-policy");
const { default: SessionProjection } = await load("@deepseek-ai/dsh-session-projection");

const workspace = mkdtempSync(join(tmpdir(), "nn-dispose-"));
mkdirSync(join(workspace, ".git"), { recursive: true });
const ctx = new Context();
await ctx.plugin(SessionProjection);
await ctx.plugin(SandboxPolicy);
await ctx.plugin(SystemPrompt);
await ctx.plugin(ToolRuntime);
await ctx.plugin(LocalFileSystem, { cwd: workspace });
await ctx.plugin(SkillRegistry);
await ctx.plugin(Commands);
ctx.sandboxPolicy.resolve = () => ({ mode: "danger-full-access", workspaceRoot: workspace });

/** 各处注册表里 `novel*` 的条目 */
async function census(ctxToCheck = ctx) {
  const tools = ctxToCheck.tools
    .schemas()
    .map((schema) => schema.name)
    .filter((name) => name.startsWith("novel_"));
  const skills = (await ctxToCheck.skills.list())
    .map((skill) => skill.name)
    .filter((name) => name.startsWith("novel"));
  let commands = [];
  try {
    const listed = ctxToCheck.commands.list?.();
    commands = (listed ?? []).map((command) => String(command?.name ?? command)).filter((n) => n.includes("novel"));
  } catch {
    commands = [];
  }
  return { tools, skills, commands };
}

const before = await census();
check("挂载前没有 novel_* 工具", before.tools.length === 0, String(before.tools.length));
check("挂载前没有 novel-* 技能", before.skills.length === 0, String(before.skills.length));

const plugin = await load("dsh-novelnovel");

console.log("--- 挂在子 scope 上再销毁 ---");
const fiber = await ctx.plugin(plugin);
await new Promise((resolve) => setTimeout(resolve, 300));
const mounted = await census();
check("挂载后工具 8 个", mounted.tools.length === 8, String(mounted.tools.length));
check("挂载后技能 6 个", mounted.skills.length === 6, String(mounted.skills.length));
console.log(`      命令: ${JSON.stringify(mounted.commands)}`);

let disposeError = null;
try {
  await fiber.dispose();
  await new Promise((resolve) => setTimeout(resolve, 300));
} catch (error) {
  disposeError = String(error?.message ?? error);
}
check("销毁没有抛错", disposeError === null, disposeError ?? "");

const after = await census();
check(
  "工具全部撤销（不然 HMR 重挂会撞 already registered）",
  after.tools.length === 0,
  `残留 ${JSON.stringify(after.tools)}`,
);
check("技能全部撤销", after.skills.length === 0, `残留 ${JSON.stringify(after.skills)}`);
check(
  "命令全部撤销",
  after.commands.length === 0,
  `残留 ${JSON.stringify(after.commands)}`,
);

console.log("--- 销毁后能干净地重新挂载吗（HMR 的真实路径）---");
{
  let remountError = null;
  try {
    await ctx.plugin(plugin);
    await new Promise((resolve) => setTimeout(resolve, 300));
  } catch (error) {
    remountError = String(error?.message ?? error);
  }
  check(
    "重挂成功（这是 HMR 每次都要走的路）",
    remountError === null,
    remountError?.slice(0, 140) ?? "",
  );
  const remounted = await census();
  check("重挂后工具仍是 8 个（没有叠加）", remounted.tools.length === 8, String(remounted.tools.length));
  check("重挂后技能仍是 6 个", remounted.skills.length === 6, String(remounted.skills.length));
}

rmSync(workspace, { recursive: true, force: true });
console.log(`\n${failed === 0 ? "全部通过" : `${String(failed)} 项失败`}：${String(passed + failed)} 项检查`);
process.exit(failed === 0 ? 0 : 1);
