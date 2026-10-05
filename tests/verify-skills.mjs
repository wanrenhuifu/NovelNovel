/**
 * 自带技能的**路由可达性**：中文触发词必须在 `description` 里。
 *
 * 这条测试来自一个实测纠正的错判。AGENTS.md 原先写着"`whenToUse` 里要保留中文触发词，
 * 否则用户用中文提问时技能匹配不上"——**这是错的**。技能目录的模板
 * （`@deepseek-ai/dsh-tool-skill` 的 catalog template，本机 asar 里就有）是：
 *
 *     <available_skills>
 *     - `<name>`: <normalized-and-capped-description>
 *
 * **只列 `description`，`whenToUse` 不进提示词**（后者只出现在 API 控制器的技能列表里，
 * 是给面板/外部消费者用的元数据）。实测把提示词全组装出来后，原文里的
 * `润色`/`改写`/`去 AI 味`/`断章` 一个都没出现——也就是说，写在 `whenToUse` 里的中文触发词
 * 对模型路由毫无作用，中文用户说"帮我润色这段"时命中率是碰运气。
 *
 * 所以这条测试盯的是：**每个技能的 `description` 都要带中文触发词**，且 frontmatter 结构完好。
 *
 * 必须用 DSH 自带的 Electron Node 运行。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

const skillDirs = readdirSync(join(repo, "skills")).filter((name) => {
  try {
    readFileSync(join(repo, "skills", name, "SKILL.md"));
    return true;
  } catch {
    return false;
  }
});

console.log(`--- 磁盘上的 SKILL.md（${String(skillDirs.length)} 个）---`);
const onDisk = new Map();
for (const dir of skillDirs) {
  const text = readFileSync(join(repo, "skills", dir, "SKILL.md"), "utf8");
  const parts = text.split("---");
  const frontmatter = parts[1] ?? "";
  const description = (/^description: (.*)$/m.exec(frontmatter) ?? [, ""])[1];
  const whenToUse = (/^whenToUse: (.*)$/m.exec(frontmatter) ?? [, ""])[1];
  onDisk.set(dir, { description, whenToUse, body: parts.slice(2).join("---") });

  check(`${dir} 的 description 是单行`, description !== "" && !description.includes("\n"), "");
  check(
    `${dir} 的 description 带中文触发词`,
    /中文触发/.test(description) && /[\u4e00-\u9fff]/.test(description),
    /中文触发/.test(description) ? "" : description.slice(-60),
  );
  check(`${dir} 的正文非空`, onDisk.get(dir).body.trim().length > 500, `${String(onDisk.get(dir).body.trim().length)} 字符`);
}

console.log("--- 真 harness 里注册出来的技能 ---");
const { Context } = await load("@deepseek-ai/cordis");
const { default: SystemPrompt } = await load("@deepseek-ai/dsh-system-prompt");
const { default: ToolRuntime } = await load("@deepseek-ai/dsh-tools");
const { default: LocalFileSystem } = await load("@deepseek-ai/dsh-fs-local");
const { default: SkillRegistry } = await load("@deepseek-ai/dsh-skill");

const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const workspace = mkdtempSync(join(tmpdir(), "nn-skills-"));
mkdirSync(join(workspace, ".git"), { recursive: true });
const ctx = new Context();
await ctx.plugin(SystemPrompt);
await ctx.plugin(ToolRuntime);
await ctx.plugin(LocalFileSystem, { cwd: workspace });
await ctx.plugin(SkillRegistry);
await ctx.plugin(await load("dsh-novelnovel"));
await new Promise((resolve) => setTimeout(resolve, 400));

const registered = await ctx.skills.list({ cwd: workspace });
check("注册出 6 个技能", registered.length === 6, String(registered.length));

for (const skill of registered) {
  // 注册出来的 description 必须与磁盘一致——否则"我改了文件但模型看不到"这种事会再发生
  const disk = onDisk.get(skill.name);
  check(`${skill.name} 已注册且与磁盘一致`, disk !== undefined && disk.description === skill.description, disk === undefined ? "磁盘上没有同名目录" : "");
  check(
    `${skill.name} 的模型可见 description 带中文触发`,
    /中文触发/.test(skill.description),
    "",
  );
}

// 记录本次纠正的结论：whenToUse 不进提示词。用真实组装结果证明，别只在注释里断言。
const assembly = await ctx.systemPrompt.assemble();
const promptText = [
  ...assembly.sections.map((section) => `${section.name}\n${section.text}`),
  ...assembly.contexts.map((context) => `${context.name}\n${context.text}`),
].join("\n");
check(
  "技能正文不进系统提示词（按需加载）",
  !promptText.includes("Narrative distance"),
  "",
);
console.log(
  `      说明：技能目录由 dsh-tool-skill 作为 user 角色消息投递（模板只含 name + description），\n` +
    `      所以 whenToUse 永远不会出现在提示词里——中文触发词必须写在 description。`,
);

rmSync(workspace, { recursive: true, force: true });
console.log(`\n${failed === 0 ? "全部通过" : `${String(failed)} 项失败`}：${String(passed + failed)} 项检查`);
process.exit(failed === 0 ? 0 : 1);
