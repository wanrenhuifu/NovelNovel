/**
 * 字数缓存的新鲜度与收益。
 *
 * 背景：`novel_project action=list` 与 `action=show` 只为"这本书有多大"就把**全书正文读一遍**
 * （实测 300 章 923/929 次 `ctx.fs` 调用）。修法是按**文件大小**缓存字数：一次 `listDir` 拿到
 * 全目录大小，大小与缓存一致就不重读正文。
 *
 * 这条测试盯两件事，缺一不可：
 * 1. **不能变旧**——这是 README 明确承诺过的行为（"list 会重新读文件统计字数，所以绕过插件直接改
 *    文件也不会失同步"）。所以直接改 `.md` 文件后字数必须立刻反映出来；
 * 2. **真的要省**——第二次调用的 `ctx.fs` 次数必须大幅下降，否则缓存等于没写。
 *
 * 必须用 DSH 自带的 Electron Node 运行。
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * 期望字数用这个算，而不是手算"每段多少字"。
 *
 * 与 `src/domain/utils.ts` 的 `countWords` **同规则**：先剥标点/符号与连接符，
 * 再按**特定码点范围**数汉字（`\u3040-\u30ff` 假名、`\u3400-\u4dbf` 扩展 A、
 * `\u4e00-\u9fff` 基本区、`\uf900-\ufaff` 兼容区、`\u{20000}-\u{2fa1f}` 扩展 B），
 * 剩下的按空白分词。
 */
function expectedWords(text) {
  if (!text.trim()) return 0;
  const cjk = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]|[\u{20000}-\u{2fa1f}]/gu;
  const stripped = text.replace(/[\p{P}\p{S}]/gu, " ").replace(/[\p{Cf}\p{Mn}\p{Me}]/gu, "");
  const counted = (stripped.match(cjk) ?? []).length;
  const rest = stripped.replace(cjk, " ").trim();
  return counted + (rest ? rest.split(/\s+/).filter(Boolean).length : 0);
}

const { Context } = await load("@deepseek-ai/cordis");
const { default: SystemPrompt } = await load("@deepseek-ai/dsh-system-prompt");
const { default: ToolRuntime } = await load("@deepseek-ai/dsh-tools");
const { default: LocalFileSystem } = await load("@deepseek-ai/dsh-fs-local");
const { default: SkillRegistry } = await load("@deepseek-ai/dsh-skill");
const { default: SandboxPolicy } = await load("@deepseek-ai/dsh-sandbox-policy");
const { default: SessionProjection } = await load("@deepseek-ai/dsh-session-projection");

const workspace = mkdtempSync(join(tmpdir(), "nn-words-"));
mkdirSync(join(workspace, ".git"), { recursive: true });
const ctx = new Context();
await ctx.plugin(SessionProjection);
await ctx.plugin(SandboxPolicy);
await ctx.plugin(SystemPrompt);
await ctx.plugin(ToolRuntime);
await ctx.plugin(LocalFileSystem, { cwd: workspace });
await ctx.plugin(SkillRegistry);
ctx.sandboxPolicy.resolve = () => ({ mode: "danger-full-access", workspaceRoot: workspace });

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

async function timed(fn) {
  calls = 0;
  const started = Date.now();
  const value = await fn();
  return { value, calls, ms: Date.now() - started };
}

const project = await call("novel_project", { action: "create", title: "字数" });
const projectId = project.result.details.project_id;
const N = 25;
const short = "雨下了一整夜。";
const long = Array.from({ length: 12 }, (_, i) => `第${String(i + 1)}段：雨下了一整夜，林晚站在檐下。`).join("\n\n");
for (let i = 1; i <= N; i += 1) {
  await call("novel_chapter", { action: "create", title: `第${String(i)}章`, text: short });
}
const chapterDir = join(workspace, ".novelnovel", "projects", projectId, "chapters");
const index = () =>
  JSON.parse(readFileSync(join(chapterDir, "index.json"), "utf8"));

console.log("--- 期望值用的计数规则与真实工具一致（防漂移）---");
{
  // 用真实工具对同一段文本的字数做比对：如果 `expectedWords` 的规则与插件里的
  // `countWords` 漂移了，这条会先失败，后面的字数断言才不会变成假失败。
  const probe = await call("novel_chapter", { action: "create", title: "计数自检", text: long });
  const read = await call("novel_chapter", { action: "read", chapter: probe.result.details.chapter_id ?? "计数自检" });
  const actual = read.result.details.words ?? read.result.details.chapter?.words;
  check(
    "测试里的计数规则与插件一致",
    actual === expectedWords(long),
    `插件 ${String(actual)} vs 测试 ${String(expectedWords(long))}`,
  );
  await call("novel_chapter", { action: "delete", chapter: probe.result.details.chapter_id ?? "计数自检", confirm: true });
}

console.log("--- 首次调用填缓存 ---");
const first = await timed(() => call("novel_project", { action: "list" }));
const firstWords = first.value.result.details.projects[0].words;
check("首次 list 成功", first.value.ok, first.value.ok ? "" : first.value.error);
check(
  "索引里写上了 wordsCache",
  index().items.every((item) => item.wordsCache !== undefined),
  `带缓存 ${String(index().items.filter((i) => i.wordsCache !== undefined).length)} / ${String(N)}`,
);
check(
  "缓存里的 size 与文件字节数一致",
  (() => {
    const meta = index().items[0];
    const bytes = readFileSync(join(chapterDir, `${meta.id}.md`)).length;
    return meta.wordsCache?.size === bytes;
  })(),
  "",
);

console.log("--- 第二次调用命中缓存（必须真的省） ---");
const second = await timed(() => call("novel_project", { action: "list" }));
check("第二次字数一致", second.value.result.details.projects[0].words === firstWords, `${String(second.value.result.details.projects[0].words)} vs ${String(firstWords)}`);
check(
  "第二次 ctx.fs 调用大幅下降",
  second.calls < first.calls / 4,
  `第二次 ${String(second.calls)} vs 首次 ${String(first.calls)}`,
);

console.log("--- 绕过插件直接改文件：字数必须跟着变（README 的承诺）---");
{
  const meta = index().items[3];
  const bodyPath = join(chapterDir, `${meta.id}.md`);
  writeFileSync(bodyPath, long, "utf8");
  const listed = await call("novel_project", { action: "list" });
  const words = listed.result.details.projects[0].words;
  const expected = firstWords - expectedWords(short) + expectedWords(long);
  check(
    "直接改文件后总字数立刻变化（没有用旧缓存）",
    words !== firstWords,
    `${String(firstWords)} → ${String(words)}`,
  );
  check("变化量正确（重算而不是估算）", words === expected, `实际 ${String(words)}，期望 ${String(expected)}`);
  const after = index();
  const updated = after.items.find((item) => item.id === meta.id);
  check(
    "缓存被刷新成新的大小",
    updated.wordsCache?.size === readFileSync(bodyPath).length,
    JSON.stringify(updated.wordsCache),
  );
}

console.log("--- novel_chapter list 的字数始终来自正文 ---");
{
  const meta = index().items[5];
  const bodyPath = join(chapterDir, `${meta.id}.md`);
  writeFileSync(bodyPath, long, "utf8");
  const list = await call("novel_chapter", { action: "list", from: 6, limit: 1 });
  check("章节列表读到改写后的正文", list.result.summary.includes("雨下了一整夜，林晚"), "");
  const entry = list.result.details.chapters[0];
  check(
    "章节列表的字数是重算的真实值",
    entry.words === expectedWords(long),
    `实际 ${String(entry.words)}，期望 ${String(expectedWords(long))}`,
  );
}

console.log("--- 正文文件被删掉时字数不为负、也不报错 ---");
{
  const before = await call("novel_project", { action: "list" });
  const base = before.result.details.projects[0].words;
  const meta = index().items[7];
  rmSync(join(chapterDir, `${meta.id}.md`), { force: true });
  // 文件大小拿不到 → 那章按 0 字算（与"正文缺失"一致），且要点名
  const listed = await call("novel_project", { action: "list" });
  check("缺正文时 list 仍成功", listed.ok, listed.ok ? "" : listed.error);
  check("缺正文的那章不再计入字数（不是用旧缓存）", listed.result.details.projects[0].words < base, `${String(base)} → ${String(listed.result.details.projects[0].words)}`);
  const chapterList = await call("novel_chapter", { action: "list", verbose: false });
  check(
    "novel_chapter list 点名缺正文",
    (chapterList.result.details.chapters_missing_body ?? []).length === 1,
    JSON.stringify(chapterList.result.details.chapters_missing_body),
  );
}

rmSync(workspace, { recursive: true, force: true });
console.log(`\n${failed === 0 ? "全部通过" : `${String(failed)} 项失败`}：${String(passed + failed)} 项检查`);
process.exit(failed === 0 ? 0 : 1);
