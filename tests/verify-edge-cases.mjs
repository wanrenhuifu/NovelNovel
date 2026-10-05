/**
 * 边界回归：那些"改对了但没人守"的口径。
 *
 * 单独立一个文件，因为它们都是**语义细节**——不是崩溃、不是丢数据，而是"静默给出另一个答案"，
 * 靠功能测试测不出来：
 *   - 章节引用解析的**优先级**（id → 标题 → 序号）：一个只写了 `3` 的引用该落到哪一章；
 *   - 词条的 `keys` 只有分隔符时必须收敛成"显式常驻"，而不是意外常驻；
 *   - `enabled` 与 `toggle` 同时给必须报错，而不是"后写的赢"（结果与原值相关、文案还说成功）。
 *
 * 必须用 DSH 自带的 Electron Node 运行。
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { load, registerHarnessHook } from "./harness-loader.mjs";

registerHarnessHook(fileURLToPath(new URL("..", import.meta.url)));

const { Context } = await load("@deepseek-ai/cordis");
const { default: SystemPrompt } = await load("@deepseek-ai/dsh-system-prompt");
const { default: ToolRuntime } = await load("@deepseek-ai/dsh-tools");
const { default: LocalFileSystem } = await load("@deepseek-ai/dsh-fs-local");
const { default: SkillRegistry } = await load("@deepseek-ai/dsh-skill");
const plugin = await load("dsh-novelnovel");

const workspace = mkdtempSync(join(tmpdir(), "nn-edge-"));
mkdirSync(join(workspace, ".git"), { recursive: true });
const ctx = new Context();
await ctx.plugin(SystemPrompt);
await ctx.plugin(ToolRuntime);
await ctx.plugin(LocalFileSystem, { cwd: workspace });
await ctx.plugin(SkillRegistry);

const registered = new Map();
const tools = ctx.tools;
const reg = tools.register.bind(tools);
tools.register = (d) => {
  registered.set(d.name, d);
  return reg(d);
};
await ctx.plugin(plugin);
await new Promise((r) => setTimeout(r, 200));

const exec = { agent: { id: "a", session: { header: { cwd: workspace } } }, signal: new AbortController().signal };
const call = (name, args) =>
  registered.get(name).execute({ ...args }, exec).then(
    (r) => ({ ok: true, r }),
    (e) => ({ ok: false, error: String(e?.message ?? e) }),
  );

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

const created = await call("novel_project", { action: "create", title: "边界" });
const projectId = created.r.details.project_id;

// ── 章节引用解析的优先级 ───────────────────────────────────────────
// 关键构造：一章**标题就叫 "3"**，同时它在列表里的位置是第 1 个。于是
//   chapter="3" → 按标题解析应得"标题为 3"的这一章；
//   chapter="1" → 没有任何标题叫 "1"，才按序号取第 1 章。
// 旧实现是"先序号后标题"，两种引用都会落到位置第 3／第 1 章上，且**不报错**。
console.log("--- 章节引用优先级 ---");
const titledThree = await call("novel_chapter", { action: "create", title: "3", text: "标题就是 3 的那一章" });
const titledThreeId = titledThree.r.details.chapter_id;
await call("novel_chapter", { action: "create", title: "第二章", text: "第二个位置" });
await call("novel_chapter", { action: "create", title: "第三章", text: "第三个位置" });

const byTitle = await call("novel_chapter", { action: "read", chapter: "3" });
check(
  "标题就叫 3 时，chapter=\"3\" 按标题解析",
  byTitle.ok && byTitle.r.details.chapter_id === titledThreeId,
  byTitle.ok ? `拿到 ${byTitle.r.details.chapter_id}` : byTitle.error,
);

const byOrdinal = await call("novel_chapter", { action: "read", chapter: "2" });
check(
  "没有标题命中时才按序号解析",
  byOrdinal.ok && byOrdinal.r.details.title === "第二章",
  byOrdinal.ok ? `拿到「${byOrdinal.r.details.title}」` : byOrdinal.error,
);

const byId = await call("novel_chapter", { action: "read", chapter: titledThreeId });
check("id 精确匹配优先于一切", byId.ok && byId.r.details.chapter_id === titledThreeId, byId.ok ? "命中" : byId.error);

const byUniquePartial = await call("novel_chapter", { action: "read", chapter: "第二" });
check(
  "标题唯一部分匹配可用",
  byUniquePartial.ok && byUniquePartial.r.details.title === "第二章",
  byUniquePartial.ok ? `拿到「${byUniquePartial.r.details.title}」` : byUniquePartial.error,
);

const outOfRange = await call("novel_chapter", { action: "read", chapter: "99" });
check(
  "序号越界要报错并给出范围（而不是静默取最后一章）",
  !outOfRange.ok && /out of range/i.test(outOfRange.error),
  outOfRange.ok ? "竟然成功了" : outOfRange.error.slice(0, 90),
);

const emptyRef = await call("novel_chapter", { action: "read", chapter: "   " });
check(
  "空引用给出可读错误（而不是 TypeError）",
  !emptyRef.ok && /required|empty/i.test(emptyRef.error),
  emptyRef.ok ? "竟然成功了" : emptyRef.error.slice(0, 90),
);

// ── 词条：keys 只有分隔符 ────────────────────────────────────────
console.log("--- 词条 keys 规范化 ---");
const separatorOnly = await call("novel_lorebook", {
  action: "add",
  name: "只有分隔符",
  keys: ",,",
  content: "内容",
});
check("加词条成功", separatorOnly.ok, separatorOnly.ok ? "" : separatorOnly.error);

const listed = await call("novel_lorebook", { action: "list" });
const stored = JSON.parse(
  readFileSync(join(workspace, ".novelnovel", "projects", projectId, "lorebook.json"), "utf8"),
).find((e) => e.name === "只有分隔符");
check(
  "keys=\",,\" 落盘成空串（与「故意留空」同一个显式状态）",
  stored !== undefined && stored.keys === "",
  JSON.stringify(stored?.keys),
);
void listed;

// ── 词条：enabled 与 toggle 同时给 ───────────────────────────────
console.log("--- enabled 与 toggle 冲突 ---");
const conflict = await call("novel_lorebook", {
  action: "update",
  entry: "只有分隔符",
  enabled: true,
  toggle: true,
});
check(
  "同时给 enabled 与 toggle 要报错（而不是后写的赢）",
  !conflict.ok && /not both/i.test(conflict.error),
  conflict.ok ? "竟然成功了" : conflict.error.slice(0, 90),
);

const enableOnly = await call("novel_lorebook", { action: "update", entry: "只有分隔符", enabled: true });
check("只给 enabled 正常", enableOnly.ok, enableOnly.ok ? "" : enableOnly.error);
const toggleOnly = await call("novel_lorebook", { action: "update", entry: "只有分隔符", toggle: true });
check("只给 toggle 正常翻转", toggleOnly.ok, toggleOnly.ok ? "" : toggleOnly.error);
const afterToggle = JSON.parse(
  readFileSync(join(workspace, ".novelnovel", "projects", projectId, "lorebook.json"), "utf8"),
).find((e) => e.name === "只有分隔符");
check("toggle 真的翻转了（true → false）", afterToggle?.enabled === false, String(afterToggle?.enabled));

// ── 危险操作缺 confirm 时必须拒绝 ────────────────────────────────
// 注意顺序：先解析出目标、再看 confirm。所以这里要**先用真实名字把目标造出来**——
// 拿不存在的名字去测，命中的是 "not found"（那是正确的顺序，但测不到 confirm 这道闸）。
console.log("--- 破坏性操作必须 confirm ---");
const presetAdded = await call("novel_preset", {
  action: "add",
  name: "待删预设",
  system_prompt: "你是写作助手",
});
check("准备：加一个预设", presetAdded.ok, presetAdded.ok ? "" : presetAdded.error);

for (const [label, run] of [
  ["词条删除", () => call("novel_lorebook", { action: "remove", entry: "只有分隔符" })],
  ["预设删除", () => call("novel_preset", { action: "remove", preset: "待删预设" })],
  ["章节删除", () => call("novel_chapter", { action: "delete", chapter: titledThreeId })],
]) {
  const outcome = await run();
  check(
    `${label}没有 confirm 时被拒`,
    !outcome.ok && /confirm/i.test(outcome.error),
    outcome.ok ? "竟然成功了" : outcome.error.slice(0, 80),
  );
}

// 技能：要先把技能包导入项目才有可删对象（内置技能不在项目里，删除接口拒绝它是对的）
console.log("--- 技能删除闸 ---");
const packPath = join(workspace, "edge-skill.json");
writeFileSync(
  packPath,
  JSON.stringify({
    name: "边界测试技能包",
    version: "1.0.0",
    skills: [{ name: "edge-skill", description: "边界测试用技能", content: "正文" }],
  }),
  "utf8",
);
const packImported = await call("novel_skill", { action: "import", path: packPath });
check("准备：导入一个技能包", packImported.ok, packImported.ok ? "" : packImported.error);
if (packImported.ok) {
  const skillNoConfirm = await call("novel_skill", { action: "remove", name: "edge-skill" });
  check(
    "技能删除没有 confirm 时被拒",
    !skillNoConfirm.ok && /confirm/i.test(skillNoConfirm.error),
    skillNoConfirm.ok ? "竟然成功了" : skillNoConfirm.error.slice(0, 80),
  );
}

// 角色卡要单独造：导入一张 JSON 卡，再用真实 id 测删除闸
console.log("--- 角色卡删除闸 ---");
const cardPath = join(workspace, "edge-card.json");
writeFileSync(
  cardPath,
  JSON.stringify({ spec: "chara_card_v2", spec_version: "2.0", data: { name: "边界卡", description: "描述" } }),
  "utf8",
);
const imported = await call("novel_character", { action: "import", path: cardPath });
check("准备：导入一张卡", imported.ok, imported.ok ? "" : imported.error);
if (imported.ok) {
  const noConfirm = await call("novel_character", {
    action: "remove",
    character: imported.r.details.character_id ?? imported.r.details.id ?? "边界卡",
  });
  check(
    "角色卡删除没有 confirm 时被拒",
    !noConfirm.ok && /confirm/i.test(noConfirm.error),
    noConfirm.ok ? "竟然成功了" : noConfirm.error.slice(0, 80),
  );
}

rmSync(workspace, { recursive: true, force: true });
console.log(`\n${failed === 0 ? "全部通过" : `${String(failed)} 项失败`}：${String(passed + failed)} 项检查`);
process.exit(failed === 0 ? 0 : 1);
