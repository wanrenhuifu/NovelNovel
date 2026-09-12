/**
 * dsh-novelnovel 端到端验证：在真实 harness 服务上跑通插件的全部工具。
 *
 * 运行方式（必须在一个能解析到 harness 依赖的 profile 目录里运行，
 * 因为 @deepseek-ai/* 由 profile 的 node_modules 提供）：
 *
 *   npm run test:dsh                          # 自动切到 profile 目录
 *   # 或手动：cd "$DSH_HOME/profiles/<profile>" && node <仓库>/tests/verify.mjs
 *
 * 验证内容：工具注册 + 作品/章节/角色卡/世界书/预设/上下文组装/导出全链路，
 * 以及技能注册与 config 校验。不调用任何模型。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(join(process.cwd(), "anchor.mjs"));
const load = async (specifier) =>
  import(pathToFileURL(require.resolve(specifier)).href);

let passed = 0;
const step = (name) => console.log(`\n▸ ${name}`);
const ok = (message, extra = "") => {
  passed++;
  console.log(`  ✓ ${message}${extra ? ` — ${extra}` : ""}`);
};

// ── 启动一个最小 harness：系统提示词 + 工具注册表 + 本地文件系统 + 技能注册表

const { Context } = await load("@deepseek-ai/cordis");
const { default: SystemPrompt } = await load("@deepseek-ai/dsh-system-prompt");
const { default: ToolRuntime } = await load("@deepseek-ai/dsh-tools");
const { default: LocalFileSystem } = await load("@deepseek-ai/dsh-fs-local");
const { default: SkillRegistry } = await load("@deepseek-ai/dsh-skill");
const plugin = await load("dsh-novelnovel");

const workspace = mkdtempSync(join(tmpdir(), "nn-dsh-"));
const ctx = new Context();
await ctx.plugin(SystemPrompt);
await ctx.plugin(ToolRuntime);
await ctx.plugin(LocalFileSystem, { cwd: workspace });
await ctx.plugin(SkillRegistry);
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
assert.ok(skills.includes("novel-writing"), "novel-writing skill 应注册");
assert.ok(skills.includes("novel-cards"), "novel-cards skill 应注册");
const writing = await ctx.skills.get("novel-writing");
assert.ok(writing?.content.includes("novel_context"), "技能正文应来自 SKILL.md");
ok("runtime skills registered", skills.filter((name) => name.startsWith("novel")).join(", "));

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

// ── 卸载清理：工具与技能都必须随插件撤销（live patch 重载的前提）

step("plugin unload");
const novelToolCount = () => ctx.tools.schemas().filter((s) => s.name.startsWith("novel_")).length;
const novelSkillCount = async () =>
  (await ctx.skills.list()).filter((s) => s.name.startsWith("novel")).length;
assert.ok(novelToolCount() === 7);
await pluginFiber.dispose();
assert.equal(novelToolCount(), 0, "卸载后工具应全部注销");
assert.equal(await novelSkillCount(), 0, "卸载后技能应全部注销");
ok("tools and skills are disposed with the plugin fiber");

console.log(`\n全部通过：${passed} 项检查。workspace=${workspace}`);
