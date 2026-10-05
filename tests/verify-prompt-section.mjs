/**
 * 系统提示词段：内容与卸载。
 *
 * 两件此前从未验证过的事：
 * 1. **文本对不对**——模型就靠这一段决定"什么时候用 novel_* 工具"，而它此前没有任何测试；
 * 2. **卸载干净吗**——`index.ts` 声称"插件卸载时由 Cordis 自动撤销"。`test:lifecycle` 已证明
 *    重复挂载会抛 `already registered`，所以段若没撤销，HMR 重挂就会失败。
 *
 * 用根 ctx 注册时**在根 scope**，所以用根上的 `assemble()` 读，不传 scope。
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
const { default: SandboxPolicy } = await load("@deepseek-ai/dsh-sandbox-policy");
const { default: SessionProjection } = await load("@deepseek-ai/dsh-session-projection");

const workspace = mkdtempSync(join(tmpdir(), "nn-prompt-"));
mkdirSync(join(workspace, ".git"), { recursive: true });
const ctx = new Context();
await ctx.plugin(SessionProjection);
await ctx.plugin(SandboxPolicy);
await ctx.plugin(SystemPrompt);
await ctx.plugin(ToolRuntime);
await ctx.plugin(LocalFileSystem, { cwd: workspace });
await ctx.plugin(SkillRegistry);
ctx.sandboxPolicy.resolve = () => ({ mode: "danger-full-access", workspaceRoot: workspace });

/** 组装一次提示词，取出我们那段 */
async function ourSections() {
  const assembly = await ctx.systemPrompt.assemble();
  return assembly.sections.filter((section) => section.name.includes("novelnovel"));
}

check("挂载前没有 novelnovel 提示词段", (await ourSections()).length === 0);

const plugin = await load("dsh-novelnovel");

console.log("--- 挂载后的提示词段 ---");
// 自定义 dataDir：既验证段确实随 config 变（thunk 生效），也验证文本渲染不抛
const fiber = await ctx.plugin(plugin, { dataDir: "custom-data" });
await new Promise((resolve) => setTimeout(resolve, 300));

const sections = await ourSections();
check("恰好一段（没有重复注册）", sections.length === 1, String(sections.length));
const text = sections[0]?.text ?? "";
check("段名正确", sections[0]?.name === "novelnovel:workspace", String(sections[0]?.name));

console.log("--- 文本内容：模型就靠它路由 ---");
check("提到数据目录（且跟随 config）", text.includes("custom-data/"), text.slice(0, 90).replace(/\n/g, " | "));
check("明确「用工具而不是手改文件」", text.includes("instead of editing the novel files by hand"));
check("给出第一步 novel_project", text.includes("`novel_project action=show`"));
check("点明 novel_context 必调", text.includes("`novel_context chapter="));
check("给出落地写入口 append", text.includes("`novel_chapter action=append`"));
check("点出 write 是替换", text.includes("`action=write` replaces a chapter"));
check("列出可加载的写作技能", /novel-prose/.test(text) && /novel-outline/.test(text));
check("声明简报优先级高于技能", /novel_context.*outranks/is.test(text));
check("要求只写正文、不要解释", /only the story text/.test(text));
// 顺序：`AssembledSection` 不带 order 字段（实测只有 name/text/interpolate），
// 所以按**它在组装结果里的位置**验证——它在（工具说明之类的前置段）之后、且确实进了组装结果。
{
  const assembly = await ctx.systemPrompt.assemble();
  const names = assembly.sections.map((section) => section.name);
  const position = names.indexOf("novelnovel:workspace");
  check(
    "段确实在组装结果里（模型看得到）",
    position >= 0,
    `共 ${String(names.length)} 段: ${names.slice(0, 6).join(", ")}`,
  );
  check(
    "排在组装结果的后半段（紧随工具说明之后，order 4500 的意图）",
    position >= Math.floor(names.length / 2),
    `位置 ${String(position + 1)}/${String(names.length)}`,
  );
}

console.log("--- 卸载后段必须消失（否则 HMR 重挂会撞车）---");
{
  let disposeError = null;
  try {
    await fiber.dispose();
    await new Promise((resolve) => setTimeout(resolve, 300));
  } catch (error) {
    disposeError = String(error?.message ?? error);
  }
  check("销毁没有抛错", disposeError === null, disposeError ?? "");
  const after = await ourSections();
  check("卸载后没有残留的提示词段", after.length === 0, `残留 ${String(after.length)} 段`);

  let remountError = null;
  try {
    await ctx.plugin(plugin, { dataDir: "custom-data" });
    await new Promise((resolve) => setTimeout(resolve, 300));
  } catch (error) {
    remountError = String(error?.message ?? error);
  }
  check("重挂成功（段名冲突会在这里暴露）", remountError === null, remountError?.slice(0, 140) ?? "");
  check("重挂后仍只有一段", (await ourSections()).length === 1, String((await ourSections()).length));
}

rmSync(workspace, { recursive: true, force: true });
console.log(`\n${failed === 0 ? "全部通过" : `${String(failed)} 项失败`}：${String(passed + failed)} 项检查`);
process.exit(failed === 0 ? 0 : 1);
