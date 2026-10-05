/**
 * dsh-novelnovel 端到端验证：在真实 harness 服务上跑通插件的全部工具。
 *
 * 运行方式：
 *
 *   npm run test:dsh                          # 用 DSH 自带的 Electron Node 跑（asar 路径需要它）
 *   # 或手动：cd "$DSH_HOME/profiles/<profile>" && node <仓库>/tests/verify.mjs
 *
 * harness 包由 tests/harness-loader.mjs 统一解析到**运行中的 DSH 安装**
 * （仓库根可能残留旧副本，先命中它就会加载出第二份服务实例）。
 *
 * 验证内容：工具注册 + 作品/章节/角色卡/世界书/预设/上下文组装/导出全链路，
 * 技能注册、命令、系统提示词段、观察记录归属、真分发链路，以及 config 校验。不调用任何模型。
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { harnessRoot, load, registerHarnessHook, resolveFrom } from "./harness-loader.mjs";

// 必须在任何插件/服务模块之前：把仓库发出的 @deepseek-ai/* 改派回 harness 安装
registerHarnessHook(fileURLToPath(new URL("..", import.meta.url)));

let passed = 0;
const step = (name) => console.log(`\n▸ ${name}`);
const ok = (message, extra = "") => {
  passed++;
  console.log(`  ✓ ${message}${extra ? ` — ${extra}` : ""}`);
};

// ── 启动一个最小 harness：系统提示词 + 工具注册表 + 本地文件系统 + 技能注册表

console.log(`harness: ${harnessRoot()}`);
const { Context } = await load("@deepseek-ai/cordis");
const { default: SystemPrompt } = await load("@deepseek-ai/dsh-system-prompt");
const { default: ToolRuntime } = await load("@deepseek-ai/dsh-tools");
const { default: LocalFileSystem } = await load("@deepseek-ai/dsh-fs-local");
const { default: SkillRegistry } = await load("@deepseek-ai/dsh-skill");
const plugin = await load("dsh-novelnovel");

const workspace = mkdtempSync(join(tmpdir(), "nn-dsh-"));
// novel_skill 按 harness 的口径把项目技能写到「最近的含 .git 的祖先目录」下；没有 .git 时会退化成 cwd，
// 结果相同，但显式放一个能让「项目根探测」在测试里确定下来（临时目录的祖先里可能有仓库）。
mkdirSync(join(workspace, ".git"), { recursive: true });
const ctx = new Context();
await ctx.plugin(SystemPrompt);
await ctx.plugin(ToolRuntime);
await ctx.plugin(LocalFileSystem, { cwd: workspace });
await ctx.plugin(SkillRegistry);

// 记录系统提示词段的注册：这是工具/技能/命令之外的第四个挂载面，
// 注册失败只会让 fiber 报错而不影响其余工具，不盯住就会静默丢失。
const promptSections = [];
const systemPromptService = ctx.systemPrompt;
const registerSection = systemPromptService.section.bind(systemPromptService);
systemPromptService.section = (section) => {
  promptSections.push(section);
  return registerSection(section);
};

const pluginFiber = await ctx.plugin(plugin, { dataDir: ".novelnovel" });

console.log(`workspace: ${workspace}`);

/** 构造工具执行上下文（与 harness 的 ToolRunContext 字段一致） */
const execFor = (name, args) => ({
  callId: `call_${name}`,
  rootCallId: `call_${name}`,
  name,
  arguments: args,
  signal: new AbortController().signal,
  token: Symbol("token"),
  agent: { id: "agent_test", session: { header: { cwd: workspace } } },
  deferContext() {},
  concludeTurn() {},
});

const call = async (name, args) => {
  const definition = ctx.tools.get(name);
  if (!definition) throw new Error(`tool "${name}" is not registered`);
  return definition.execute(args, execFor(name, args));
};

/** 用指定的 exec 调用工具（需要固定 session 对象的场景，如观察记录归属） */
const callWith = async (exec, name, args) => {
  const definition = ctx.tools.get(name);
  if (!definition) throw new Error(`tool "${name}" is not registered`);
  return definition.execute(args, exec);
};

/**
 * 真分发链路：走 ctx.tools.execute（参数校验 → 策略 → 定义自己的 execute → 输出校验 → 渲染）。
 * 上面两个 helper 直接调定义，绕过了 harness 的 schema 校验——工具参数键名写错、或者
 * 声明的 output schema 与返回值漂移，只有这条路径能发现（0.2.0-rc.2 的 validateArgs /
 * valueSchema 投影都在这里）。
 */
const dispatch = async (name, args) => {
  const controller = new AbortController();
  return ctx.tools.execute({
    callId: `dispatch_${name}`,
    rootCallId: `dispatch_${name}`,
    name,
    arguments: args,
    agent: { id: "agent_dispatch", session: { header: { cwd: workspace } } },
    signal: controller.signal,
  });
};

/** 从分发结果里取出工具返回值（失败时把 model-facing 内容带进断言信息） */
const dispatchedValue = (result) => {
  if (result.isError) {
    throw new Error(`dispatch failed: ${result.content.map((block) => block.text).join("")}`);
  }
  return result.value;
};

const toolNames = ctx.tools
  .schemas()
  .map((schema) => schema.name)
  .filter((name) => name.startsWith("novel_"))
  .sort();
step("tools registered");
assert.deepEqual(toolNames, [
  "novel_chapter",
  "novel_character",
  "novel_context",
  "novel_export",
  "novel_lorebook",
  "novel_preset",
  "novel_project",
  "novel_skill",
]);
ok(`${toolNames.length} novel_* tools visible to the model`, toolNames.join(", "));

// ── 作品

step("novel_project");
const created = await call("novel_project", {
  action: "create",
  title: "长夜将至",
  synopsis: "边陲小城的守夜人发现长夜提前降临。",
  worldbuilding: "长夜每二十年降临一次，城中以灯火为界。",
  author_note: "冷峻克制，少用形容词。",
});
assert.equal(created.details.project_id, "novel", "纯中文标题回退到 novel 目录名");
assert.ok(created.summary.includes("长夜将至"));
ok("created project", created.details.project_id);

const listed = await call("novel_project", { action: "list" });
assert.equal(listed.details.projects.length, 1);
ok("listed projects", `${listed.details.projects.length} project`);

// author_note → project.json 的 authorNote（工具参数是 snake_case，落盘字段是驼峰）
const projectFile = join(workspace, ".novelnovel", "projects", created.details.project_id, "project.json");
const storedProject = JSON.parse(readFileSync(projectFile, "utf8"));
assert.equal(storedProject.authorNote, "冷峻克制，少用形容词。");
assert.equal(storedProject.worldbuilding, "长夜每二十年降临一次，城中以灯火为界。");
ok("project fields land in project.json with the right keys");

// ── 章节

step("novel_chapter");
await call("novel_chapter", { action: "create", title: "第一章 灯下" });
await call("novel_chapter", { action: "create", title: "第二章 边界" });
const appended = await call("novel_chapter", {
  action: "append",
  chapter: "第一章",
  text: "灯芯爆了一下。\n\n守夜人抬起头，看见城墙上空的夜色比昨夜更浓。",
});
assert.ok(appended.details.words > 0);
ok("chapter created and prose appended", `${appended.details.words} words`);

const chapters = await call("novel_chapter", { action: "list" });
assert.equal(chapters.details.chapters.length, 2);
assert.equal(chapters.details.chapters[0].title, "第一章 灯下");
ok("chapter list in order", chapters.details.chapters.map((c) => c.title).join(" → "));

const read = await call("novel_chapter", { action: "read", chapter: "1" });
assert.ok(read.details.content.includes("守夜人抬起头"));
ok("read by 1-based number resolves the chapter");

// 移动章节：第二章 移到 第一章 之前
const moved = await call("novel_chapter", {
  action: "move",
  chapter: "第二章",
  target: "第一章",
  relative: "before",
});
assert.equal(moved.details.order[0], chapters.details.chapters[1].id);
ok("reorder normalizes sortOrder", "第二章 → 第一章");

// 移回去，保持后续断言的可读顺序
await call("novel_chapter", {
  action: "move",
  chapter: "第一章",
  target: "第二章",
  relative: "before",
});

const tagged = await call("novel_chapter", {
  action: "tag",
  chapter: "1",
  add_tags: ["伏笔"],
});
assert.deepEqual(tagged.details.tags, ["伏笔"]);
ok("tags updated");

// 破坏性操作必须先确认
await assert.rejects(
  () => call("novel_chapter", { action: "delete", chapter: "2" }),
  /confirm=true/,
);
ok("delete refuses without confirm=true");

// ── 世界观词条

step("novel_lorebook");
await call("novel_lorebook", {
  action: "add",
  name: "灯火之界",
  content: "城中每座灯楼守着一道界，灯灭则夜入。",
});
await call("novel_lorebook", {
  action: "add",
  name: "长夜纪年",
  keys: "长夜, 二十年",
  content: "长夜每二十年降临一次，上一次是春分。",
});
const lore = await call("novel_lorebook", { action: "list" });
assert.equal(lore.details.always_on, 1);
assert.equal(lore.details.keyword_triggered, 1);
ok("always-on and keyword-triggered entries", "1 / 1");

// ── 角色卡（JSON 卡 + 内嵌世界书 → 导出 PNG → 再导入回读）

step("novel_character");
const cardPath = join(workspace, "linwan.json");
writeFileSync(
  cardPath,
  JSON.stringify(
    {
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        name: "林晚",
        description: "{{char}}是守夜人，左眼有一道旧伤。",
        personality: "沉默，认死理。",
        scenario: "长夜将至的边陲小城。",
        first_mes: "灯下站着一个人。",
        mes_example: "",
        creator_notes: "示例卡",
        creator: "novelnovel",
        character_book: {
          entries: [
            {
              name: "旧伤",
              keys: ["左眼", "旧伤"],
              content: "{{char}}的左眼是在上一次长夜中被灼伤的。",
              enabled: true,
            },
            { name: "空白条目", keys: ["x"], content: "   ", enabled: true },
          ],
        },
      },
    },
    null,
    2,
  ),
  "utf8",
);

const imported = await call("novel_character", { action: "import", path: cardPath });
assert.equal(imported.details.name, "林晚");
assert.equal(imported.details.lore_entries_merged, 1, "空内容词条应被丢弃");
ok("imported JSON card", `v2, merged ${imported.details.lore_entries_merged} world-book entry`);

const characterId = imported.details.character_id;
const merged = await call("novel_lorebook", { action: "list" });
const mergedEntry = merged.details.entries.find((entry) => entry.name === "旧伤");
assert.ok(mergedEntry, "卡内世界书应并入项目 lorebook");
ok("card world book merged into the project lorebook");

const showCard = await call("novel_character", { action: "show", character: "林晚" });
assert.ok(showCard.summary.includes("{{char}}是守夜人"), "卡片字段按原样存储（宏在组装时解析）");
ok("card fields stored verbatim, macros resolved at assembly time");

const exported = await call("novel_character", {
  action: "export",
  character: characterId,
  out_path: join(workspace, "linwan-roundtrip.png"),
});
assert.ok(existsSync(exported.details.path));
const pngBytes = readFileSync(exported.details.path);
assert.equal(pngBytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "应是合法 PNG");
assert.ok(pngBytes.includes(Buffer.from("chara")), "PNG 应写入 chara chunk");
const roundTrip = await call("novel_character", {
  action: "import",
  path: exported.details.path,
});
assert.equal(roundTrip.details.name, "林晚");
assert.equal(roundTrip.details.spec, "v2", "V2 卡再导出后仍按 chara 回读");
ok("exported PNG round-trips back as a card", exported.details.path.split(/[\\/]/).pop());

// V3 卡再导出时应双写 ccv3（读取端 ccv3 优先）
const v3Path = join(workspace, "v3card.json");
writeFileSync(
  v3Path,
  JSON.stringify({
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: { name: "祭司", description: "夜祷的主持者。", extensions: {}, tags: [] },
  }),
  "utf8",
);
const v3Imported = await call("novel_character", { action: "import", path: v3Path });
assert.equal(v3Imported.details.spec, "v3");
const v3Exported = await call("novel_character", {
  action: "export",
  character: v3Imported.details.character_id,
  out_path: join(workspace, "priest.png"),
});
const v3Png = readFileSync(v3Exported.details.path);
assert.ok(v3Png.includes(Buffer.from("chara")), "V3 卡应写 chara");
assert.ok(v3Png.includes(Buffer.from("ccv3")), "V3 卡应同时写 ccv3");
const v3RoundTrip = await call("novel_character", {
  action: "import",
  path: v3Exported.details.path,
});
assert.equal(v3RoundTrip.details.spec, "v3", "ccv3 优先于 chara");
ok("V3 card exports both chara + ccv3 chunks and reads back as v3");

const disabled = await call("novel_character", { action: "disable", character: "林晚" });
assert.equal(disabled.details.active, false);
await call("novel_character", { action: "enable", character: "林晚" });
ok("participation toggles");

// ── 预设

step("novel_preset");
const presetPath = fileURLToPath(
  new URL("../samples/preset-example.json", import.meta.url),
);
const presetImported = await call("novel_preset", { action: "import", path: presetPath });
assert.equal(presetImported.details.kind, "system");
assert.equal(presetImported.details.activated, true, "首个可用预设应自动激活");
ok("imported SillyTavern sysprompt preset", presetImported.details.preset_id);

// 同名重导入是替换：必须沿用原 id。若换了新 id，activePresetId 会悬空，
// 于是「列表显示有激活项」但简报静默退回内置默认提示词。
const presetReimported = await call("novel_preset", { action: "import", path: presetPath });
assert.equal(
  presetReimported.details.preset_id,
  presetImported.details.preset_id,
  "同名重导入应沿用原预设 id",
);
assert.equal(presetReimported.details.replaced_active, true, "被替换的正是激活项应如实报告");
const presetsAfterReimport = await call("novel_preset", { action: "list" });
assert.equal(presetsAfterReimport.details.presets.length, 1, "重导入应替换而不是追加");
assert.equal(
  presetsAfterReimport.details.active_preset_id,
  presetImported.details.preset_id,
  "重导入后激活项应保持有效",
);
ok("same-name re-import keeps the preset id and stays active");

// ── 上下文组装

step("novel_context");
await call("novel_chapter", {
  action: "append",
  chapter: "第一章",
  text: "他想起长夜纪年里写过的话：二十年一轮，灯不灭则人不亡。",
});
const context = await call("novel_context", {
  chapter: "第二章",
  instruction: "写林晚在城墙下遇到祭司",
});
assert.equal(context.details.project_id, "novel");
assert.ok(context.summary.includes("长夜每二十年降临一次"), "命中关键词的词条应注入");
assert.ok(context.summary.includes("灯火之界"), "常驻词条应注入");
assert.ok(context.details.injected_entries.includes("长夜纪年"), "关键词命中的词条应出现在注入清单里");
assert.ok(context.details.injected_entries.includes("灯火之界"), "常驻词条应出现在注入清单里");
assert.ok(context.summary.includes("林晚"), "参与角色应注入");
assert.ok(context.summary.includes("第一章 灯下"), "前文章节摘录应带上");
assert.ok(context.summary.includes("林晚在城墙下遇到祭司"));
assert.ok(context.summary.includes("守夜人，左眼有一道旧伤"), "预设 systemPrompt 应替换默认开场白");
assert.equal(context.details.preset, "古风章回体（示例）", "同名重导入后激活的预设仍应生效");
assert.ok(context.summary.includes("古典章回体"), "预设正文应出现在简报里（内置默认提示词没有这句）");
assert.ok(context.details.prev_chapters.length === 1);
ok("brief assembled", `preset=${context.details.preset}, injected=${context.details.injected_entries.length} entries, prev=${context.details.prev_chapters.length} chapter`);

// 关键词未命中时不注入该词条（recent_chars=0 表示不带本章正文，也是 slice(-0) 的回归用例）
const cold = await call("novel_context", { chapter: "第二章", recent_chars: 0, prev_chapters: 0 });
assert.ok(!cold.details.injected_entries.includes("长夜纪年"), "关键词不在上下文里时不应注入该词条");
assert.ok(cold.details.injected_entries.includes("灯火之界"), "常驻词条仍应注入");
assert.equal(cold.details.recent_chars, 0, "recent_chars=0 时不应截取整章");
ok("keyword-scoped injection verified (hit and miss)");

// ── 检索 / 导出

step("novel_chapter search");
const hits = await call("novel_chapter", { action: "search", query: "守夜人" });
assert.ok(hits.details.hits.length >= 1);
ok("full-text search", `${hits.details.hits.length} hit(s)`);

step("novel_export");
const md = await call("novel_export", { action: "markdown" });
assert.ok(existsSync(join(workspace, md.details.path.replace(/^\.novelnovel\//, ".novelnovel/"))));
const mdText = readFileSync(join(workspace, md.details.path), "utf8");
assert.ok(mdText.startsWith("# 长夜将至"));
assert.equal(md.details.chapters, 2);
ok("markdown export", md.details.path);

const backup = await call("novel_export", { action: "backup" });
const backupJson = JSON.parse(readFileSync(join(workspace, backup.details.path), "utf8"));
const cardCount = (await call("novel_character", { action: "list" })).details.characters.length;
assert.equal(backupJson.format, "novelnovel-backup");
assert.equal(backupJson.chapters.length, 2);
assert.equal(backupJson.characters.length, cardCount, "备份应包含全部角色卡");
assert.equal(backupJson.lorebook.length, 3, "备份应包含项目世界书（含卡内并入的词条）");
assert.ok(backupJson.presets.presets.length === 1);
ok("backup export", `${backupJson.characters.length} cards, ${backupJson.lorebook.length} lorebook entries`);

// ── 技能

step("skills");
const skills = (await ctx.skills.list()).map((skill) => skill.name);
// 不硬编码技能名：加了一个 SKILL.md 却因为 frontmatter 写错而静默注册失败，是最容易漏的一类回归
const bundledDir = join(dirname(resolveFrom("dsh-novelnovel/package.json")), "skills");
const bundled = readdirSync(bundledDir)
  .map((entry) => {
    const file = join(bundledDir, entry, "SKILL.md");
    if (!existsSync(file)) return null;
    const match = /^---\r?\n[\s\S]*?^name:\s*(.+)$/m.exec(readFileSync(file, "utf8"));
    return (match ? match[1] : entry).trim().replace(/^["']|["']$/g, "");
  })
  .filter((name) => name !== null);
assert.ok(bundled.length >= 6, `skills/ 下的技能应被枚举到，实际 ${bundled.length} 个`);
for (const name of bundled) {
  assert.ok(skills.includes(name), `技能 ${name} 应注册（检查它的 SKILL.md）`);
}
const writing = await ctx.skills.get("novel-writing");
assert.ok(writing?.content.includes("novel_context"), "技能正文应来自 SKILL.md");
const craft = await ctx.skills.get("novel-prose");
assert.ok((craft?.content.length ?? 0) > 500, "写作方法技能应带完整正文");
ok("runtime skills registered", `${bundled.length} bundled: ${bundled.join(", ")}`);

// ── 项目级技能：novel_skill 的导入 / 列表 / 导出 / 删除往返
// 落盘位置是 harness 自己的技能根（项目根 .dsh/skills），加载由 harness 负责，这里只验证文件写得对。

step("novel_skill (project skills)");
const skillsRoot = join(workspace, ".dsh", "skills");
const emptyList = await call("novel_skill", { action: "list" });
assert.equal(emptyList.details.skills.length, 0, "还没有技能时应报空");

const packFile = (name, body) => {
  writeFileSync(join(workspace, name), `${JSON.stringify(body, null, 2)}\n`);
};
packFile("pack.json", {
  name: "测试方法包",
  version: "1.0.0",
  skills: [
    { name: "test-craft", description: "A test craft skill.", whenToUse: "测试", content: "# Test\n\nBody." },
    { name: "test-pacing", description: "A test pacing skill.", content: "# Pacing\n\nBody." },
  ],
});
const importedPack = await call("novel_skill", { action: "import", path: "pack.json" });
assert.equal(importedPack.details.skills.length, 2);
assert.deepEqual(importedPack.details.skills.map((s) => s.name), ["test-craft", "test-pacing"]);
assert.ok(importedPack.details.skills.every((s) => !s.overwritten), "首次导入不算覆盖");

const craftFile = join(skillsRoot, "test-craft", "SKILL.md");
assert.ok(existsSync(craftFile), "导入应把 SKILL.md 落到项目根的 .dsh/skills");
const craftText = readFileSync(craftFile, "utf8");
assert.ok(craftText.includes("whenToUse: 测试"), "frontmatter 应带上 whenToUse");
assert.ok(craftText.includes("# Test"), "正文应落盘");
assert.ok(
  existsSync(join(skillsRoot, "test-craft", ".novelnovel-skill.json")),
  "应写入导入标记（否则之后删不掉）",
);
ok("import pack", importedPack.details.skills.map((s) => s.path).join(", "));

const projectSkillList = await call("novel_skill", { action: "list" });
assert.deepEqual(projectSkillList.details.skills.map((s) => s.name), ["test-craft", "test-pacing"]);
assert.ok(projectSkillList.details.skills.every((s) => s.imported), "应标注为导入的");
ok("list project skills", `${projectSkillList.details.skills.length} skills`);

// 校验失败必须整体中止：不能写一半才发现第二个技能名非法
packFile("bad-pack.json", {
  skills: [
    { name: "would-be-written", description: "Fine.", content: "Body." },
    { name: "Not Kebab", description: "Broken.", content: "Body." },
  ],
});
await assert.rejects(
  () => call("novel_skill", { action: "import", path: "bad-pack.json" }),
  /not kebab-case/,
);
assert.ok(!existsSync(join(skillsRoot, "would-be-written")), "校验失败时不应写一半");

// 手写技能（没有标记）一律不动：覆盖要 overwrite，删除直接拒绝
const handWritten = join(skillsRoot, "hand-written", "SKILL.md");
mkdirSync(dirname(handWritten), { recursive: true });
writeFileSync(handWritten, "---\nname: hand-written\ndescription: Hand written.\n---\n\nBody.\n");
packFile("collide.json", {
  skills: [{ name: "hand-written", description: "Replacement.", content: "Body." }],
});
await assert.rejects(
  () => call("novel_skill", { action: "import", path: "collide.json" }),
  /not imported by novel_skill/,
);
assert.ok(
  readFileSync(handWritten, "utf8").includes("Hand written."),
  "被拒绝的导入不应改动手写技能",
);
ok("hand-written skills are left alone");

// 删除：手写的拒绝，导入的必须 confirm
await assert.rejects(
  () => call("novel_skill", { action: "remove", name: "hand-written", confirm: true }),
  /not imported by novel_skill/,
);
await assert.rejects(() => call("novel_skill", { action: "remove", name: "test-craft" }), /confirm=true/);
const removed = await call("novel_skill", { action: "remove", name: "test-craft", confirm: true });
assert.equal(removed.details.name, "test-craft");
assert.ok(!existsSync(join(skillsRoot, "test-craft")), "删除应移除整个技能目录");
ok("remove requires confirm and only touches imported skills");

// 导出：复现导入标记里的包名，且产物必须能原样再导入
const exportedCall = await call("novel_skill", { action: "export", name: "test-pacing" });
const exportFile = join(workspace, ".novelnovel", "skillpacks", "test-pacing.json");
assert.ok(existsSync(exportFile), `导出的技能包应落在 <dataDir>/skillpacks/（${exportedCall.details.path}）`);
const repack = JSON.parse(readFileSync(exportFile, "utf8"));
assert.equal(repack.name, "测试方法包", "导出应沿用导入标记里的包名");
assert.equal(repack.skills[0].name, "test-pacing");
packFile("roundtrip.json", repack);
const reimported = await call("novel_skill", { action: "import", path: "roundtrip.json" });
assert.equal(reimported.details.skills[0].name, "test-pacing");
assert.ok(reimported.details.skills[0].overwritten, "再导入同一个技能应报告为覆盖");
ok("export pack → re-import", exportedCall.details.path);

// ── 系统提示词段：插件应注册一段引导（order 4500）

step("system prompt section");
const promptSection = promptSections.find((section) => section.name === "novelnovel:workspace");
assert.ok(promptSection, "插件应注册系统提示词段 novelnovel:workspace");
assert.equal(promptSection.order, 4500, "order 应与首方工具说明相邻");
const promptText =
  typeof promptSection.text === "function" ? promptSection.text({}) : promptSection.text;
assert.ok(promptText.includes("novel_*"), "提示词段应点名工具家族");
assert.ok(promptText.includes("novel_context"), "提示词段应引导先取写作简报");
ok("prompt section registered", `order=${promptSection.order}, ${promptText.length} chars`);

// ── /novel 斜杠命令
// 真品 CommandRuntime 依赖 typert 服务栈，这里用一个只记录注册的 commands 服务替身，
// 验证注册形状与处理器逻辑（真实注册路径由随后的 dsh 实跑覆盖）。

step("/novel command");
const registered = [];
const commandsStub = {
  name: "test-commands-stub",
  apply(stubCtx) {
    stubCtx.provide("commands", {
      register(definition) {
        registered.push(definition);
        return () => {};
      },
    });
  },
};
await ctx.plugin(commandsStub);
assert.equal(registered.length, 1, "插件应注册一个命令");
const [novelCommand] = registered;
assert.equal(novelCommand.name, "novel");
assert.equal(typeof novelCommand.handler, "function");
const status = await novelCommand.handler({
  rawInput: "",
  signal: new AbortController().signal,
  agent: { session: { header: { cwd: workspace } } },
});
assert.equal(status.kind, "success");
assert.ok(status.text.includes("《长夜将至》"), "应报告当前作品");
assert.ok(status.text.includes("章节 2"), "应报告章节数");
ok("handler reports the current project", status.text.split("\n")[0]);

const switched = await novelCommand.handler({
  rawInput: "长夜",
  signal: new AbortController().signal,
  agent: { session: { header: { cwd: workspace } } },
});
assert.equal(switched.kind, "success");
const missing = await novelCommand.handler({
  rawInput: "不存在的作品",
  signal: new AbortController().signal,
  agent: { session: { header: { cwd: workspace } } },
});
assert.equal(missing.kind, "error", "无法解析的作品名应返回 error 而不是抛出");
ok("handler switches by name and fails soft on unknown input");

// ── 健壮性与沙箱边界（回归用例）

step("robustness");
// 1) 二进制写入（node:fs，不受沙箱约束）必须被插件自己限定在工作区内
const outside = mkdtempSync(join(tmpdir(), "nn-outside-"));
await assert.rejects(
  () =>
    call("novel_character", {
      action: "export",
      character: characterId,
      out_path: join(outside, "escaped.png"),
    }),
  /outside the workspace/,
);
assert.equal(existsSync(join(outside, "escaped.png")), false);
ok("binary export outside the workspace is refused", outside);

// 2) 损坏的作品目录不该让 list / 解析当前作品整体失败
const brokenDir = join(workspace, ".novelnovel", "projects", "broken");
mkdirSync(brokenDir, { recursive: true });
writeFileSync(join(brokenDir, "project.json"), "{ not json", "utf8");
const listing = await call("novel_project", { action: "list" });
assert.equal(listing.details.projects.length, 1, "可读作品仍应列出");
assert.equal(listing.details.unreadable.length, 1, "坏目录应被跳过并报告");
assert.ok(listing.summary.includes("broken"), "报告里应点名坏目录");
ok("a broken project directory is skipped and reported");

// 2b) 单张角色卡坏掉不该让 novel_context / 卡片列表整体失效
const charactersDir = join(workspace, ".novelnovel", "projects", "novel", "characters");
writeFileSync(join(charactersDir, "broken.json"), "{ not json", "utf8");
const resilientContext = await call("novel_context", { chapter: "1", project: "novel" });
assert.equal(resilientContext.action, "context", "一张坏卡不该让简报组装失败");
ok("a corrupted character card does not break the writing brief");
rmSync(join(charactersDir, "broken.json"), { force: true });

// 2c) 二进制导出不得覆盖已存在的文件（out_path 是模型可控参数）
const indexFile = join(workspace, ".novelnovel", "projects", "novel", "chapters", "index.json");
const indexBackup = readFileSync(indexFile, "utf8");
await assert.rejects(
  () =>
    call("novel_character", {
      action: "export",
      character: characterId,
      project: "novel",
      out_path: indexFile,
    }),
  /refusing to overwrite the existing file/,
  "导出到已有文件必须被拒绝",
);
assert.equal(readFileSync(indexFile, "utf8"), indexBackup, "被拒绝的导出不能改动文件");
ok("binary export refuses to overwrite an existing file");

// 2d) 追加保真：前导空行与 markdown 硬换行（行尾两空格）是正文的一部分
{
  const created = await call("novel_chapter", {
    action: "create",
    project: "novel",
    title: "空白保真",
  });
  const chapterId = created.details.chapter_id;
  await call("novel_chapter", {
    action: "append",
    project: "novel",
    chapter: chapterId,
    text: "\n首行前面有空行  \n第二行带硬换行",
  });
  const body = readFileSync(
    join(workspace, ".novelnovel", "projects", "novel", "chapters", `${chapterId}.md`),
    "utf8",
  );
  assert.ok(body.includes("首行前面有空行  \n第二行带硬换行"), "硬换行与空行必须原样保留");
  assert.ok(body.startsWith("\n"), "前导空行不能被 trim 掉");
  await call("novel_chapter", {
    action: "append",
    project: "novel",
    chapter: chapterId,
    text: "第三段",
  });
  const second = readFileSync(
    join(workspace, ".novelnovel", "projects", "novel", "chapters", `${chapterId}.md`),
    "utf8",
  );
  assert.ok(second.includes("第二行带硬换行\n\n第三段"), "追加之间补一个空行分隔");
  await call("novel_chapter", {
    action: "delete",
    project: "novel",
    chapter: chapterId,
    confirm: true,
  });
  ok("append preserves meaningful whitespace and only adds a separator");
}

// 2e) 参数边界：不能让模型拿到「假否定」或静默错位的落点
await assert.rejects(
  () => call("novel_chapter", { action: "search", project: "novel", query: "雪", limit: 0 }),
  /limit must be a positive integer/,
  "limit=0 会渲染成「没有命中」，必须报错",
);
await assert.rejects(
  () => call("novel_chapter", { action: "create", project: "novel", title: "错位", position: 0 }),
  /position must be a positive integer/,
  "position=0 会被静默当成追加，必须报错",
);
const positioned = await call("novel_chapter", {
  action: "create",
  project: "novel",
  title: "插入到首位",
  position: 1,
});
assert.equal(positioned.details.position, 1, "返回里要回显最终序号");
await call("novel_chapter", {
  action: "delete",
  project: "novel",
  chapter: positioned.details.chapter_id,
  confirm: true,
});
ok("position/limit boundaries are validated and the final position is echoed");

// 2f) 同名预设：再加一个必须报错，而不是并存到「精确匹配永远命中第一个」
await call("novel_preset", { action: "add", project: "novel", name: "重名测试", system_prompt: "甲" });
await assert.rejects(
  () =>
    call("novel_preset", {
      action: "add",
      project: "novel",
      name: "重名测试",
      system_prompt: "乙",
    }),
  /already exists/,
  "同名 add 应被拒绝",
);
await assert.rejects(
  () => call("novel_preset", { action: "update", project: "novel", preset: "重名测试", name: "  " }),
  /cannot be empty/,
  "空名必须报错，而不是报「已更新」却什么都没改",
);
ok("duplicate preset names and empty names are refused");

// 3) 没有当前作品且存在多个作品时，必须显式指定，避免写错作品
await call("novel_project", { action: "create", title: "第二部" });
writeFileSync(join(workspace, ".novelnovel", "workspace.json"), "{ broken", "utf8");
await assert.rejects(
  () => call("novel_chapter", { action: "list" }),
  /pass project=/,
  "无从判断当前作品时必须要求显式指定",
);
const explicit = await call("novel_chapter", { action: "list", project: "novel" });
assert.equal(explicit.action, "list");
ok("ambiguous target is refused; explicit project still works");

// 4) 1-based 序号解析：解析引用走的是「只读元数据」的列表，必须与列表展示同一顺序
const byIndex = await call("novel_chapter", { action: "list", project: "1" });
assert.equal(byIndex.details.project_id, "novel", "project=1 应按 action=list 的顺序解析");
const byTitle = await call("novel_chapter", { action: "list", project: "第二部" });
assert.equal(byTitle.details.project_id, "novel-2", "中文标题应能解析到 auto slug 的作品");
ok("project resolves by 1-based index and by CJK title");
// 修回工作区指针，供后续步骤使用
writeFileSync(
  join(workspace, ".novelnovel", "workspace.json"),
  JSON.stringify({ version: 1, activeProject: "novel" }),
  "utf8",
);

// ── 配置校验

step("config validation");
const { resolveConfig } = plugin;
assert.equal(resolveConfig({}).dataDir, ".novelnovel");
assert.equal(resolveConfig({ defaultPrevChapterCount: 3 }).defaultPrevChapterCount, 3);
assert.throws(() => resolveConfig({ dataDir: "/etc/novels" }), /inside the workspace/);
assert.throws(() => resolveConfig({ dataDir: "../outside" }), /inside the workspace/);
assert.throws(() => resolveConfig({ defaultRecentChars: -1 }), /non-negative integer/);
ok("invalid config fails loudly; defaults applied");

// ── 观察记录归属：插件的写入要记在调用方会话名下（与首方 write 工具一致），
//    否则 harness 的「先读后写」策略看不到这些改动。

step("observation policy");
// 该包以模块级 apply/name 形式导出插件（无 default），直接把命名空间交给 ctx.plugin
const observationPolicy = await load("@deepseek-ai/dsh-fs-observation-policy");
await ctx.plugin(observationPolicy);
const stableExec = execFor("novel_chapter", {});
const observedWrite = await callWith(stableExec, "novel_chapter", {
  action: "append",
  chapter: "2",
  text: "雾里的灯又亮了一盏。",
});
const chapterFile = join(
  workspace,
  ".novelnovel",
  "projects",
  "novel",
  "chapters",
  `${observedWrite.details.chapter_id}.md`,
);
const chapterTarget = await ctx.fs.resolve(chapterFile, { cwd: workspace });
// cordis 的 waterfall 末参是 fallback：不传它，exec 会被当成 fallback 吞掉
const ownIntent = await ctx.waterfall("fs/write-intent", chapterTarget, stableExec, () => undefined);
assert.equal(
  ownIntent.kind,
  "replaceIfVersion",
  "插件写入应记在本会话名下（策略据此给出带版本校验的写入意图）",
);
const otherIntent = await ctx.waterfall(
  "fs/write-intent",
  chapterTarget,
  execFor("novel_chapter", {}),
  () => undefined,
);
assert.equal(otherIntent.kind, "createIfAbsent", "未观察过该文件的会话不应拿到版本校验意图");
ok("plugin writes are recorded in the read-before-write gate for the calling session");

// ── 真分发链路：参数校验 + 输出校验都由 harness 执行（上面所有检查都绕过了它）

step("dispatch through ctx.tools.execute");
const dispatchedProject = dispatchedValue(
  await dispatch("novel_project", { action: "show", project: "novel" }),
);
assert.equal(dispatchedProject.action, "show");
assert.ok(dispatchedProject.summary.includes("长夜将至"), "分发结果应带回简报文本");
assert.equal(dispatchedProject.details.project_id, "novel", "details 走 json 节点，值应原样透出");
ok("arguments validated and declared output schema enforced on a real dispatch");

const dispatchedChapter = dispatchedValue(
  await dispatch("novel_chapter", { action: "list", project: "novel" }),
);
assert.equal(dispatchedChapter.details.chapters.length > 0, true);
ok("second action dispatches too", `${dispatchedChapter.details.chapters.length} chapters`);

// 参数校验确实生效：缺必填字段的调用必须成为错误结果，而不是抛到调用方
const invalid = await dispatch("novel_project", { action: "create" });
assert.equal(invalid.isError, true, "缺 title 的 create 应被参数校验拦下");
assert.ok(
  invalid.content.map((block) => block.text).join(" ").length > 0,
  "错误结果要有模型可读的文本",
);
ok("invalid arguments become a normal error result");

// ── 索引缺失：有正文却没有索引时必须拒绝写入（否则全书大纲会被一次建章覆盖）
//    放在这里是因为它会新建作品，而自动 slug 的序号会影响前面的断言。

step("missing chapter index");
const orphan = await call("novel_project", { action: "create", title: "索引缺失" });
const orphanProject = orphan.details.project_id;
await call("novel_chapter", { action: "create", title: "第一章" });
const orphanIndex = join(
  workspace,
  ".novelnovel",
  "projects",
  orphanProject,
  "chapters",
  "index.json",
);
const orphanIndexBackup = readFileSync(orphanIndex, "utf8");
rmSync(orphanIndex, { force: true });
await assert.rejects(
  () => call("novel_chapter", { action: "create", title: "第二章" }),
  // 判据是内容层面的「目录里有索引未引用的 .md」，所以索引缺失与
  // 「索引被改成 {} 后能解析但语义为空」这两类走的是同一条错误
  /not listed in\s+chapters\/index\.json/,
  "有正文却没有索引时必须拒绝写入",
);
// 空目录里缺索引是正常的（首次建章），不该被拦
const emptyProject = await call("novel_project", { action: "create", title: "空作品" });
const emptyCreate = await call("novel_chapter", { action: "create", title: "第一章" });
assert.equal(emptyCreate.action, "create", "空目录里没有索引时应当允许建章");
assert.ok(emptyProject.details.project_id);
writeFileSync(orphanIndex, orphanIndexBackup, "utf8");
ok("a missing chapter index with existing prose refuses to write");
ok("a corrupted-but-parsable chapter index also refuses to write");

// ── workspace.json 写坏后仍能自愈 ─────────────────────────────────
// 曾经的 bug：`readWorkspace` 把"坏了"当成"不存在"（返回 existed:false），于是写指针选
// createIfAbsent、撞上那个坏文件报 "cannot overwrite … without reading it first" ——
// 所有会写指针的入口（action=create / action=use）全失败，错误文案还把用户指向"你没先读它"。
// 现在坏文件保留它的版本当基准，写入直接覆盖修复。
step("corrupted workspace pointer self-heals");
const workspaceFile = join(workspace, ".novelnovel", "workspace.json");
const workspaceBackup = readFileSync(workspaceFile, "utf8");
writeFileSync(workspaceFile, "{ 坏掉的 JSON", "utf8");
const healed = await call("novel_project", { action: "use", project: orphanProject });
assert.equal(healed.action, "use", "workspace.json 写坏后 action=use 应当能重建指针");
const healedRaw = readFileSync(workspaceFile, "utf8");
assert.doesNotThrow(() => JSON.parse(healedRaw), "自愈后 workspace.json 必须是合法 JSON");
assert.equal(JSON.parse(healedRaw).activeProject, orphanProject, "自愈后指针指向被选中的作品");
writeFileSync(workspaceFile, workspaceBackup, "utf8");
ok("a corrupted workspace.json is rebuilt instead of blocking every pointer write");

// ── 没有会话工作区时，写入必须被拒绝而不是落到 process.cwd() ──────
// 探针实测过这条坑：exec.agent 缺失时 cwd 兜底到 process.cwd()（桌面端=应用安装目录），
// 数据静默写进那里——用户工作区里什么都没有，那个目录也不在面板白名单里，既看不到也选不中。
step("no-session writes are refused");
const bareExec = { signal: new AbortController().signal };
const bareWrite = await callWith(bareExec, "novel_project", { action: "create", title: "不该建成" }).then(
  () => "成功了（闸没拦住！）",
  (error) => String(error?.message ?? error),
);
assert.match(bareWrite, /no session workspace/, "无会话的写入应被明确拒绝");
assert.equal(
  existsSync(join(workspace, ".novelnovel", "projects")),
  true,
  "拒绝写入不该影响已有数据",
);
// 读路径不该被这道闸误伤：无会话也要能列出（读错目录只是读到空，无害）
const bareRead = await callWith(bareExec, "novel_project", { action: "list" }).then(
  () => "ok",
  (error) => `失败: ${String(error?.message ?? error)}`,
);
assert.equal(bareRead, "ok", "无会话的读操作应当照常工作");
ok("a write with no session workspace is refused instead of landing in process.cwd()");

// ── 卸载清理：工具与技能都必须随插件撤销（live patch 重载的前提）

step("plugin unload");
const novelToolCount = () => ctx.tools.schemas().filter((s) => s.name.startsWith("novel_")).length;
const novelSkillCount = async () =>
  (await ctx.skills.list()).filter((s) => s.name.startsWith("novel")).length;
// 工具清单由开头的断言固定，这里不重复硬编码数量，只确认卸载前确实都还在
assert.equal(novelToolCount(), toolNames.length, "卸载前应有全部工具");
await pluginFiber.dispose();
assert.equal(novelToolCount(), 0, "卸载后工具应全部注销");
assert.equal(await novelSkillCount(), 0, "卸载后技能应全部注销");
ok("tools and skills are disposed with the plugin fiber");

console.log(`\n全部通过：${passed} 项检查。workspace=${workspace}`);
