/**
 * `novel_chapter action=list` 的分页与精简：**用计数证明它真的省了**。
 *
 * 为什么需要：这是唯一能按顺序看章节的入口，而长篇下它原来会逐章读全文并把每一章塞进
 * summary——实测 60 章 201 次 `ctx.fs` 调用、6555 字符进模型上下文；3000 章约 10 万字符。
 * 这条测试数 `ctx.fs` 调用次数与 summary 长度，确保分页与 `verbose=false` 真的把成本降下来
 * （而不是只在文案上"看起来分了页"）。
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

const workspace = mkdtempSync(join(tmpdir(), "nn-page-"));
mkdirSync(join(workspace, ".git"), { recursive: true });
const ctx = new Context();
await ctx.plugin(SessionProjection);
await ctx.plugin(SandboxPolicy);
await ctx.plugin(SystemPrompt);
await ctx.plugin(ToolRuntime);
await ctx.plugin(LocalFileSystem, { cwd: workspace });
await ctx.plugin(SkillRegistry);
ctx.sandboxPolicy.resolve = () => ({ mode: "danger-full-access", workspaceRoot: workspace });

/** 数 ctx.fs 调用 */
let calls = 0;
const fs = ctx.fs;
for (const name of ["resolve", "stat", "readText", "listDir", "writeText", "readBytes"]) {
  if (typeof fs[name] !== "function") continue;
  const original = fs[name].bind(fs);
  fs[name] = (...args) => {
    calls += 1;
    return original(...args);
  };
}

await ctx.plugin(await load("dsh-novelnovel"));
await new Promise((resolve) => setTimeout(resolve, 200));

const exec = { agent: { id: "a", session: { header: { cwd: workspace } } }, signal: new AbortController().signal };
const call = (name, args) =>
  ctx.tools.get(name).execute({ ...args }, exec).then(
    (result) => ({ ok: true, result }),
    (error) => ({ ok: false, error: String(error?.message ?? error) }),
  );

const project = await call("novel_project", { action: "create", title: "分页" });
const projectId = project.result.details.project_id;
const body = Array.from(
  { length: 40 },
  (_, i) => `第${String(i + 1)}段：雨下了一整夜，林晚站在檐下看着街尽头那盏灯。`,
).join("\n\n");

const N = 30;
for (let i = 1; i <= N; i += 1) {
  const made = await call("novel_chapter", { action: "create", title: `第${String(i)}章`, text: body });
  if (!made.ok) {
    check(`准备：建第 ${String(i)} 章`, false, made.error);
    break;
  }
}
check(`准备：建好 ${String(N)} 章`, true);

/** 跑一次 list，返回 { calls, chars, result } */
async function measure(args) {
  calls = 0;
  const result = await call("novel_chapter", { action: "list", ...args });
  const summary = result.ok ? result.result.summary : "";
  if (!result.ok) check(`list ${JSON.stringify(args)} 成功`, false, result.error);
  return { calls, chars: summary.length, summary, result };
}

console.log("--- 全量 list 是基准 ---");
const full = await measure({});
check("全量 list 返回全部章节", full.result.result.details.chapters.length === N, String(full.result.result.details.chapters.length));
check("全量 list 给出 total_chapters", full.result.result.details.total_chapters === N, String(full.result.result.details.total_chapters));

console.log("--- 分页真的省了取数 ---");
{
  const page = await measure({ from: 11, limit: 5 });
  check(
    "from/limit 只返回窗口内的章节",
    page.result.result.details.chapters.length === 5,
    String(page.result.result.details.chapters.length),
  );
  check(
    "窗口的 index 是绝对序号（11..15）",
    page.result.result.details.chapters.map((c) => c.index).join(",") === "11,12,13,14,15",
    page.result.result.details.chapters.map((c) => c.index).join(","),
  );
  check("给出 total_chapters 便于翻页", page.result.result.details.total_chapters === N, String(page.result.result.details.total_chapters));
  check("给出 shown", page.result.result.details.shown === 5, String(page.result.result.details.shown));
  // 关键：调用次数必须显著低于全量（读窗口 5 章 vs 读 30 章）
  check(
    "分页的 ctx.fs 调用明显少于全量",
    page.calls < full.calls * 0.6,
    `分页 ${String(page.calls)} vs 全量 ${String(full.calls)}`,
  );
  check(
    "分页的 summary 明显短于全量",
    page.chars < full.chars * 0.6,
    `分页 ${String(page.chars)} 字符 vs 全量 ${String(full.chars)} 字符`,
  );
  check("提示怎么继续翻页", /page with from=/i.test(page.summary), "");
}

console.log("--- verbose=false 更省（连预览都不要）---");
{
  const compact = await measure({ verbose: false });
  check(
    "compact 比全量短得多",
    compact.chars < full.chars * 0.6,
    `compact ${String(compact.chars)} 字符 vs 全量 ${String(full.chars)} 字符`,
  );
  check("compact 仍给出全部章节", compact.result.result.details.chapters.length === N, String(compact.result.result.details.chapters.length));
  check("compact 不含正文预览", !compact.summary.includes("雨下了一整夜"), "");
  check("compact 不含 tags 段落", !/tags:/.test(compact.summary), "");
}

console.log("--- 边界 ---");
{
  const beyond = await measure({ from: 100, limit: 5 });
  check("from 超出范围 → 空窗口（不报错）", beyond.result.result.details.chapters.length === 0, String(beyond.result.result.details.chapters.length));
  const zero = await measure({ from: 1, limit: 0 });
  check("limit=0 → 空窗口（不报错）", zero.result.result.details.chapters.length === 0, String(zero.result.result.details.chapters.length));
  const negative = await measure({ from: -5, limit: 3 });
  check("from 为负数 → 夹到 1", negative.result.result.details.chapters[0]?.index === 1, JSON.stringify(negative.result.result.details.chapters.map((c) => c.index)));
  const fractional = await measure({ from: 2.7, limit: 2.2 });
  check(
    "小数被截断（不产生半章）",
    fractional.result.result.details.chapters.map((c) => c.index).join(",") === "2,3",
    fractional.result.result.details.chapters.map((c) => c.index).join(","),
  );
  const huge = await measure({ from: 1, limit: 1e9 });
  check("超大 limit → 全部（不越界）", huge.result.result.details.chapters.length === N, String(huge.result.result.details.chapters.length));
  // NaN / Infinity 由 harness 在 schema 层就拒掉（"must be a finite JSON number"），
  // 比插件自己兜底更好——所以这里断言"被拒"，而不是"退回默认值"。
  const nanFrom = await call("novel_chapter", { action: "list", from: Number.NaN, limit: 2 });
  check(
    "from=NaN 被 schema 拒绝（不进入插件）",
    nanFrom.ok === false && /finite/i.test(String(nanFrom.error)),
    nanFrom.ok ? "竟然成功了" : String(nanFrom.error).slice(0, 70),
  );
}

console.log("--- 缺正文的点名在分页下也要有 ---");
{
  const chaptersDir = join(workspace, ".novelnovel", "projects", projectId, "chapters");
  const metas = await call("novel_chapter", { action: "list", verbose: false });
  const target = metas.result.details.chapters[4];
  rmSync(join(chaptersDir, `${target.id}.md`), { force: true });
  const page = await measure({ from: 4, limit: 3 });
  check(
    "窗口内的缺正文被点名",
    (page.result.result.details.chapters_missing_body ?? []).length === 1,
    JSON.stringify(page.result.result.details.chapters_missing_body),
  );
  check("summary 里也点名", /body file is missing/i.test(page.summary), "");
}

rmSync(workspace, { recursive: true, force: true });
console.log(`\n${failed === 0 ? "全部通过" : `${String(failed)} 项失败`}：${String(passed + failed)} 项检查`);
process.exit(failed === 0 ? 0 : 1);
