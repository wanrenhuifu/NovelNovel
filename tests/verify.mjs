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
  "novel_review",
  "novel_skill",
  "novel_source",
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
// 大纲第一层此时还没写：老作品（project.json 里没有 outline）的简报不该凭空多出大纲区块
assert.ok(!context.summary.includes("## 全书大纲"), "没有 outline 的老作品不产生大纲区块");
assert.ok(context.details.prev_chapters.length === 1);
ok("brief assembled", `preset=${context.details.preset}, injected=${context.details.injected_entries.length} entries, prev=${context.details.prev_chapters.length} chapter`);

// 关键词未命中时不注入该词条（recent_chars=0 表示不带本章正文，也是 slice(-0) 的回归用例）
const cold = await call("novel_context", { chapter: "第二章", recent_chars: 0, prev_chapters: 0 });
assert.ok(!cold.details.injected_entries.includes("长夜纪年"), "关键词不在上下文里时不应注入该词条");
assert.ok(cold.details.injected_entries.includes("灯火之界"), "常驻词条仍应注入");
assert.equal(cold.details.recent_chars, 0, "recent_chars=0 时不应截取整章");
ok("keyword-scoped injection verified (hit and miss)");

// ── 章级 goal（大纲第三层）：老索引缺字段时一切照旧，写了就必须进简报的指令块
// goal 搭不上 buildSystemPrompt 的车（那里面收不到章节元数据），只能走指令块这条路；
// summary 则**故意不注入**（有损摘要不能挤掉原文，见 docs/design/auto-writer.md §3.1）。
step("chapter goal in the brief");
{
  const goalIndexFile = join(
    workspace,
    ".novelnovel",
    "projects",
    "novel",
    "chapters",
    "index.json",
  );
  assert.equal(context.details.goal, null, "没有 goal 的老索引应如实报 null");
  assert.ok(!context.summary.includes("本章目标"), "没有 goal 时简报里不该出现目标行");

  const indexDoc = JSON.parse(readFileSync(goalIndexFile, "utf8"));
  const goalMeta = indexDoc.items.find((item) => item.title.includes("第二章"));
  assert.ok(goalMeta, "索引里应有第二章");
  const goal = "让林晚在城墙下遇到祭司，并让他第一次说出长夜的来历";
  goalMeta.goal = goal;
  goalMeta.summary = "本节摘要不该进简报";
  writeFileSync(goalIndexFile, `${JSON.stringify(indexDoc, null, 2)}\n`, "utf8");

  const goalContext = await call("novel_context", {
    chapter: "第二章",
    instruction: "写林晚在城墙下遇到祭司",
  });
  assert.equal(goalContext.details.goal, goal, "details 应暴露当前章的 goal");
  assert.ok(goalContext.summary.includes(`本章目标：${goal}`), "goal 必须进简报的指令块");
  assert.ok(
    goalContext.summary.indexOf("本章目标：") < goalContext.summary.indexOf("续写要求："),
    "goal 是这一章的框架，应排在续写要求之前",
  );
  assert.ok(!goalContext.summary.includes("本节摘要不该进简报"), "summary 字段不注入简报");

  const noGoalContext = await call("novel_context", {
    chapter: "第一章",
    recent_chars: 0,
    prev_chapters: 0,
  });
  assert.equal(noGoalContext.details.goal, null, "同一本书里没有 goal 的章节仍报 null");
  assert.ok(!noGoalContext.summary.includes("本章目标"), "没有 goal 的章节不受影响");
  ok("chapter goal reaches the brief (old indexes still assemble unchanged)");
}

// ── 大纲的**写入通道**（第二阶段）：outline / goal / summary 现在用工具写得进去
// 上一段验的是消费侧（手改索引后简报是否照做）；这一段验写入口：工具写 → 落盘 → 立刻被简报读到，
// 以及"空串 = 清空"（与其他 update 字段同一口径）。没有这一段，"工具说更新了、文件里没有"
// 这类静默无操作就只能靠手测发现。
step("outline & chapter meta write channel");
{
  const indexFile = join(workspace, ".novelnovel", "projects", "novel", "chapters", "index.json");
  const projectFile = join(workspace, ".novelnovel", "projects", "novel", "project.json");
  const outline = "全书梗概：林晚为了找回被长夜吞掉的十年，必须亲手点亮最后一座灯楼。";
  const outlineUpdate = await call("novel_project", { action: "update", outline });
  assert.deepEqual(outlineUpdate.details.updated, ["outline"], "只改 outline 时 updated 应只有它");
  const shown = await call("novel_project", { action: "show" });
  assert.equal(shown.details.outline, outline, "action=show 应回显 outline");
  assert.ok(shown.summary.includes(outline), "action=show 的文本里要有 outline");
  assert.equal(
    JSON.parse(readFileSync(projectFile, "utf8")).outline,
    outline,
    "outline 必须真的落进 project.json",
  );

  // 大纲第一层是 Push：写进去之后**每一章**的简报都要自动带上（设计文档 §4「不可遗漏」）。
  // 这个作品此刻激活的是「古风章回体（示例）」——一个**只有 systemPrompt、没有 story_string**
  // 的预设，所以这一段同时守着"大纲真的进了系统提示词、而不是只躺在 details 里"。
  const outlineBrief = await call("novel_context", {
    chapter: "第一章",
    recent_chars: 0,
    prev_chapters: 0,
  });
  assert.ok(
    outlineBrief.summary.includes(`## 全书大纲\n${outline}`),
    "outline 必须作为独立区块进简报的系统提示词",
  );
  assert.ok(
    outlineBrief.summary.indexOf("## 全书大纲") <
      outlineBrief.summary.indexOf("## Instruction block"),
    "大纲属于系统提示词部分，应排在指令块之前",
  );
  // 另一章同样带上（Push 是"每章"，不是"某一章"）
  const otherOutlineBrief = await call("novel_context", {
    chapter: "第二章",
    recent_chars: 0,
    prev_chapters: 0,
  });
  assert.ok(otherOutlineBrief.summary.includes(`## 全书大纲\n${outline}`), "换一章也要带上 outline");

  const outlineCleared = await call("novel_project", { action: "update", outline: "" });
  assert.deepEqual(outlineCleared.details.updated, ["outline"], "空串也算「传了参数」");
  const afterClear = await call("novel_project", { action: "show" });
  assert.equal(afterClear.details.outline, null, "空串应清空 outline 并如实报 null");
  assert.ok(!afterClear.summary.includes(outline), "清空后不该再显示大纲");

  // 清空 = 回到老作品形状：简报里不该留空壳区块（逐字退回第一步验过的那个形状）
  const clearedOutlineBrief = await call("novel_context", {
    chapter: "第一章",
    recent_chars: 0,
    prev_chapters: 0,
  });
  assert.ok(!clearedOutlineBrief.summary.includes("## 全书大纲"), "清空 outline 后不该再有区块");
  assert.ok(!clearedOutlineBrief.summary.includes(outline), "清空后不该再带上旧大纲文本");

  const noFields = await call("novel_project", { action: "update" }).then(
    () => "成功了（闸没拦住！）",
    (error) => String(error?.message ?? error),
  );
  assert.match(noFields, /outline/, "nothing-to-update 的提示要把 outline 一起列上");

  // 章级 goal / summary 的写入口
  const metaGoal = "让林晚在灯楼下承认她骗了祭司";
  const metaSummary = "林晚与祭司对峙，灯楼第一次亮起。";
  const patched = await call("novel_chapter", {
    action: "meta",
    chapter: "第一章",
    goal: metaGoal,
    summary: metaSummary,
  });
  assert.equal(patched.details.goal, metaGoal);
  assert.equal(patched.details.summary, metaSummary);
  const writtenMeta = JSON.parse(readFileSync(indexFile, "utf8")).items.find((item) =>
    item.title.includes("第一章"),
  );
  assert.equal(writtenMeta.goal, metaGoal, "goal 必须真的落进索引");
  assert.equal(writtenMeta.summary, metaSummary, "summary 必须真的落进索引");

  const metaContext = await call("novel_context", {
    chapter: "第一章",
    instruction: "写灯楼下的对峙",
  });
  assert.equal(metaContext.details.goal, metaGoal, "工具写的 goal 必须立刻进简报");
  assert.ok(metaContext.summary.includes(`本章目标：${metaGoal}`), "goal 应进指令块");
  assert.ok(!metaContext.summary.includes(metaSummary), "summary 写进来也不注入简报");

  // action=create 也收 goal；用一章一次性验证，验完删掉以免影响后面的章节数断言
  const created = await call("novel_chapter", {
    action: "create",
    title: "第三章 过渡",
    goal: "把林晚送回北境",
  });
  assert.equal(created.details.goal, "把林晚送回北境", "action=create 应接受 goal");
  await call("novel_chapter", { action: "delete", chapter: created.details.chapter_id, confirm: true });

  // 两个参数都不给时明确报错（而不是静默成功）
  const emptyMeta = await call("novel_chapter", { action: "meta", chapter: "第一章" }).then(
    () => "成功了（闸没拦住！）",
    (error) => String(error?.message ?? error),
  );
  assert.match(emptyMeta, /goal and\/or summary/, "action=meta 空调用应说明要传什么");

  // 清空 goal 后简报必须退回旧形状（不是留一行空的「本章目标：」）
  await call("novel_chapter", { action: "meta", chapter: "第一章", goal: "" });
  const clearedContext = await call("novel_context", { chapter: "第一章" });
  assert.equal(clearedContext.details.goal, null, "清空 goal 后应报 null");
  assert.ok(!clearedContext.summary.includes("本章目标"), "清空 goal 后简报不该有目标行");
  ok("outline / goal / summary are writable through the tools (empty string clears)");
}

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

// ── 面板写入也要记账（写路由没有 exec，但 actor 能从白名单里那个真 Session 造出来）────
// 这条以前是"已知例外"：HTTP 路由没有 exec → `fs/observed` 不带 actor → 策略看不到 →
// 模型随后用首方 write/edit 会被要求"先读一遍"（写入明明刚发生过）。现在
// `NovelStore.writeWorkspaceOf` 用白名单里的真 Session 构造 actor（策略取 owner 的方式是
// `actor?.agent?.session`），所以面板写入与工具写入走的是同一条记账路径。
step("panel writes are recorded too");
{
  const panelRoutes = new Map();
  ctx.provide("connection", {
    fetch: {
      register(route) {
        panelRoutes.set(route.path, route);
        return Promise.resolve();
      },
    },
  });
  // 软挂载：connection 是 provide 之后回调才跑的（插件 apply 时它还不存在）
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(panelRoutes.size, 4, "三条读 + 一条角色卡（读写共用 path）");
  for (const path of ["/api/novel.projects", "/api/novel.project", "/api/novel.chapter", "/api/novel.character"]) {
    assert.ok(panelRoutes.has(path), `${path} 应注册`);
  }

  const route = panelRoutes.get("/api/novel.chapter");
  const target = `http://localhost/api/novel.chapter?project=novel`;
  // 先让 **stableExec** 用一次工作区：白名单里存的是"最后一次记住的那个真 Session 对象"，
  // 而这个用例后面要拿 stableExec 去问策略——不先固定住，别处插一次 call() 就会换掉它
  await callWith(stableExec, "novel_project", { action: "show", project: "novel" });
  const readBack = await route.fetch(new Request(`${target}&chapter=${observedWrite.details.chapter_id}`));
  const current = (await readBack.json()).data.chapter.content;

  const written = await route.fetch(
    new Request(target, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "write",
        chapter: observedWrite.details.chapter_id,
        content: "面板改过的一行。",
        expectedContent: current,
      }),
    }),
  );
  assert.equal(written.status, 200, `面板写正文应成功（实际 ${String(written.status)}）`);

  const panelIntent = await ctx.waterfall(
    "fs/write-intent",
    chapterTarget,
    stableExec,
    () => undefined,
  );
  assert.equal(
    panelIntent.kind,
    "replaceIfVersion",
    "面板写入必须记在那个真会话名下，否则模型之后会被要求先读一遍",
  );
  ok("panel writes are recorded in the read-before-write gate");
}

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

// ── 索引列着、正文不在：列表必须点名，而不是显示成 (empty) ────────
// `deleteChapter` 先删正文再改索引，两步之间被中断（取消/失败）就留下这种半步状态。
// 此前 `list` 把它显示成 `(empty)`，而 `read` 对同一章报 "body file is missing"——
// 同一份数据两种说法，用户看不出哪个是真的。
step("missing chapter body is reported by list");
{
  const listProject = await call("novel_project", { action: "create", title: "缺正文" });
  const listPid = listProject.details.project_id;
  const made = await call("novel_chapter", { action: "create", title: "会丢正文的一章", text: "内容" });
  const chaptersDir = join(workspace, ".novelnovel", "projects", listPid, "chapters");
  const beforeList = await call("novel_chapter", { action: "list" });
  assert.equal(
    beforeList.details.chapters_missing_body,
    undefined,
    "正文都在时不该报缺正文",
  );
  rmSync(join(chaptersDir, `${made.details.chapter_id}.md`), { force: true });
  const afterList = await call("novel_chapter", { action: "list" });
  assert.ok(
    afterList.summary.includes("body file is missing"),
    "列表要点名正文缺失，而不是显示 (empty)",
  );
  assert.match(
    afterList.summary,
    /body file is missing/,
    "提示里要说明索引仍列着这一章",
  );
  assert.deepEqual(
    afterList.details.chapters_missing_body,
    [made.details.chapter_id],
    "details 里要给出缺失的章节 id",
  );
  // read 与 list 的口径必须一致：两边都报"正文不在"。
  // 注意 `assert.rejects` 的第三参是"**没有**拒绝时抛出的文案"，不是自定义断言信息——
  // 传字符串进去会变成它内部的断言失败（我在这里踩过一次，报错看着像"正则不匹配"）。
  const readOutcome = await call("novel_chapter", { action: "read", chapter: made.details.chapter_id }).then(
    () => "成功了（应当报缺正文）",
    (error) => String(error?.message ?? error),
  );
  assert.match(readOutcome, /body .{0,12}missing/, `read 也要报缺正文，实际: ${readOutcome.slice(0, 140)}`);
  ok("a chapter whose body is gone is named by list, not shown as empty");
}

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

// ── 已取消的调用不该落地任何写入 ──────────────────────────────────
// 实测：正常分发链路下 `ctx.fs.resolve` 自己就会拒绝（"resolve aborted"），所以取消不会落地。
// 插件侧的 `assertWritable` 是**纵深防御**——直接调 definition.execute 的调用方（以及将来
// 某个不经过 resolve 的写路径）仍会被它挡住。这条用例两种拒绝都接受，但必须确认"什么都没落地"。
step("cancelled writes are refused");
const cancelled = new AbortController();
cancelled.abort();
const cancelledExec = {
  ...execFor("novel_chapter", {}),
  signal: cancelled.signal,
};
const cancelledWrite = await callWith(cancelledExec, "novel_chapter", {
  action: "create",
  title: "取消后不该建出来",
}).then(
  () => "成功了（没拦住！）",
  (error) => String(error?.message ?? error),
);
assert.match(
  cancelledWrite,
  /cancelled before writing|aborted/i,
  "已取消的写入应被拒绝（harness 的 resolve aborted 或插件自己的 cancelled before writing）",
);
// 用正常会话读回来确认"什么都没落地"（复用已取消的 exec 会在列目录时就 abort）
const afterCancel = await call("novel_chapter", { action: "list" });
const cancelledTitles = afterCancel.details.chapters.map((c) => c.title);
assert.ok(
  !cancelledTitles.includes("取消后不该建出来"),
  `被取消的章节不该出现在列表里（实际：${cancelledTitles.join(" / ")}）`,
);
ok("a write on an already-aborted signal lands nothing");

// ── 章级自检（第 4 步）+ 词条注入治理（第 6 步）──────────────────────
//
// 为什么用一个**假 subagents 服务**：真起子 agent 就要调模型，而本仓库的口径是"不调模型也能
// 证明它对"。假服务验的是我们这一半——传出去的 spec（材料、权限收窄、persona、schema）与拿回来
// 之后的处理（落盘、连败计数、降级）。真品那一半由 `dsh-subagent` 保证：`allow: []` 不会把
// 子 agent 自己的 `structured_output` 一起收掉，harness 源码里有明文——限制只作用于**继承来的**
// 表面，自己这一层注册的东西不受影响（dsh-tools/lib/index.js 的 `view()`）。

step("novel_review");
const reviewCalls = [];
let subagentReply = { structured: undefined, output: [] };
ctx.provide("subagents", {
  start(provider, request) {
    reviewCalls.push({ provider, request });
    return Promise.resolve({
      id: `sub_${reviewCalls.length}`,
      result: Promise.resolve(subagentReply),
      dispose: () => Promise.resolve(),
    });
  },
  list: () => ["spawn", "fork"],
});
/** 设下一次子 agent 的返回（structured 优先，output 是纯文本兜底那条路） */
const replyWith = (structured, output = []) => {
  subagentReply = { structured, output };
};
const replyText = (text) => {
  subagentReply = { structured: undefined, output: [{ type: "text", text }] };
};
await new Promise((resolve) => setTimeout(resolve, 50)); // 等 ctx.inject 的软挂载回调

const readIndex = () => JSON.parse(readFileSync(indexFile, "utf8"));

// **自备一个作品**：前面的 robustness 用例会改写甚至掏空主作品的索引，终态不可依赖。
// 这样这一节想看什么材料就自己铺什么材料，断言也不受别处顺序影响。
const reviewGoal = "让林晚在灯楼下承认她早就知道长夜会提前";
const reviewOutline = "全书梗概：林晚用十年找回被长夜吞掉的灯楼。";
const reviewProject = (await call("novel_project", { action: "create", title: "自检用例" })).details
  .project_id;
const reviewChapter = (await call("novel_chapter", {
  action: "create",
  project: reviewProject,
  title: "第二章 对峙",
  goal: reviewGoal,
  text: "灯芯爆了一下。守夜人抬起头，看见城墙上空的夜色比昨夜更浓。",
})).details.chapter_id;
const reviewFirst = (await call("novel_chapter", {
  action: "create",
  project: reviewProject,
  title: "第一章 起始",
  text: "他想起长夜纪年里写过的话：二十年一轮，灯不灭则人不亡。",
  position: 1,
})).details.chapter_id;
await call("novel_lorebook", {
  action: "add",
  project: reviewProject,
  name: "灯火之界",
  keys: "",
  content: "城中以灯火为界，灯灭则长夜入城。",
});
await call("novel_lorebook", {
  action: "add",
  project: reviewProject,
  name: "长夜纪年",
  keys: "长夜",
  content: "长夜纪年记载：二十年一轮，灯不灭则人不亡。",
});
await call("novel_project", { action: "update", project: reviewProject, outline: reviewOutline });
const reviewIndexFile = join(
  workspace,
  ".novelnovel",
  "projects",
  reviewProject,
  "chapters",
  "index.json",
);
const reviewIndex = () => JSON.parse(readFileSync(reviewIndexFile, "utf8"));
const reviewMeta = () => reviewIndex().items.find((item) => item.id === reviewChapter);
const firstMeta = () => reviewIndex().items.find((item) => item.id === reviewFirst);
/** 这一节的调用统一带上自备作品，免得受"当前作品"指针影响 */
const reviewCall = (args) => call("novel_review", { project: reviewProject, ...args });
const draft = "夜色压下来时，林晚把铜铃按在胸口，一步步走向灯楼。祭司站在门里，没有说话。";

// ① 本地硬门槛先跑：没过就不起子 agent（省一次模型往返）
const callsBeforeLocal = reviewCalls.length;
const badLocal = await reviewCall({ chapter: reviewChapter, text: `## 第二章\n${draft}` });
assert.equal(badLocal.details.verdict, "fail");
assert.equal(badLocal.details.semantic_check, "local-only");
assert.equal(reviewCalls.length, callsBeforeLocal, "本地门槛没过时不该起子 agent");
assert.ok(badLocal.summary.includes("Markdown heading"), "问题要点名是哪一类");
assert.equal(badLocal.details.attempts, 1, "判不合格要计数");
assert.equal(reviewMeta().review.attempts, 1, "计数必须落盘（模型自己数记不住）");
assert.equal(reviewMeta().review.verdict, "fail");
ok("local gate runs first and skips the sub-agent");

// ② 子 agent 判不合格：问题、计数、**不写摘要**（正文马上要重写，摘要就是假信息）
replyWith({ verdict: "fail", issues: ["没有推进本章目标", "与上一章的结尾矛盾"] });
const failedReview = await reviewCall({ chapter: reviewChapter, text: draft });
assert.equal(failedReview.details.verdict, "fail");
assert.equal(failedReview.details.semantic_check, "ok");
assert.equal(failedReview.details.issues.length, 2);
assert.equal(failedReview.details.attempts, 2);
assert.equal(failedReview.details.summary_stored, false, "判不合格时不该写摘要");
assert.equal(reviewMeta().summary, undefined, "摘要字段不该被写进去");
assert.equal(failedReview.details.reviewed, "draft", "审的是草稿就要如实说");

// 传出去的 spec：材料齐、权限收窄、persona 与 schema 都在
const spec = reviewCalls.at(-1);
assert.equal(spec.provider, "spawn", "优先用干净上下文的 spawn");
assert.deepEqual(spec.request.toolFilter, { allow: [] }, "子 agent 的全局工具必须被收空");
assert.ok((spec.request.persona ?? "").length > 50, "要有角色说明");
assert.equal(spec.request.outputSchema.type, "object", "outputSchema 必须是 object 根的标准 JSON Schema");
assert.ok(spec.request.outputSchema.required.includes("verdict"));
assert.equal(spec.request.parent.id, "agent_test", "parent 必须是调用方那个活 Agent");
assert.equal(spec.request.prompt[0].type, "text");
const material = spec.request.prompt[0].text;
assert.ok(material.includes(reviewGoal), "本章目标要进材料");
assert.ok(material.includes(reviewOutline), "全书大纲要进材料");
assert.ok(material.includes("灯火之界"), "命中词条要进材料");
assert.ok(
  material.includes("他想起长夜纪年里写过的话"),
  `上一章尾部要进材料（实际材料：\n${material}）`,
);

// schema 用**真品校验器**过一遍：provider 会把 outputSchema 直接注册成子 agent 的
// `structured_output` 参数，形状不合规会在 `setup()` 里抛错——那会把整条语义自检变成
// "failed"，而且只在运行期暴露。这里用 harness 自己的 `assertObjectJsonSchema` /
// `validateJsonSchemaValue` 钉住，比自己再写一遍 JSON Schema 断言可信。
const dshTools = await load("@deepseek-ai/dsh-tools");
dshTools.assertObjectJsonSchema(spec.request.outputSchema);
assert.equal(
  dshTools.validateJsonSchemaValue(spec.request.outputSchema, {
    verdict: "pass",
    issues: [],
    summary: "x",
    lore: [{ name: "n", keys: "k", content: "c" }],
  }).length,
  0,
  "合法结论必须通过真品校验",
);
assert.ok(
  dshTools.validateJsonSchemaValue(spec.request.outputSchema, { verdict: "maybe", issues: [] }).length > 0,
  "乱写的 verdict 要被真品校验拒掉",
);
assert.ok(
  dshTools.validateJsonSchemaValue(spec.request.outputSchema, { verdict: "pass" }).length > 0,
  "缺 issues 要被真品校验拒掉",
);
assert.ok(
  dshTools.validateJsonSchemaValue(spec.request.outputSchema, { verdict: "pass", issues: [], extra: 1 }).length > 0,
  "additionalProperties=false 要真的挡住多余字段",
);
ok("sub-agent receives goal + outline + lore + previous tail, stripped of every global tool");

// ③ 通过：计数归零、摘要落盘、新设定建议回给前台（**由前台决定要不要写**）
replyWith({
  verdict: "pass",
  issues: [],
  summary: "林晚在灯楼下与祭司对峙，灯楼第一次亮起。",
  lore: [{ name: "灯楼", keys: "灯楼", content: "灯楼是城中唯一能压住长夜的建筑。" }],
});
const passedReview = await reviewCall({ chapter: reviewChapter, text: draft });
assert.equal(passedReview.details.verdict, "pass");
assert.equal(passedReview.details.attempts, 0, "通过要归零");
assert.equal(passedReview.details.summary_stored, true);
assert.equal(reviewMeta().summary, "林晚在灯楼下与祭司对峙，灯楼第一次亮起。");
assert.equal(passedReview.details.lore_suggestions.length, 1, "新设定建议要回给前台");
assert.ok(passedReview.summary.includes("novel_lorebook action=add"), "要告诉模型建议怎么落地");
assert.equal(
  (await call("novel_lorebook", { action: "list", project: reviewProject })).details.entries.some((entry) => entry.name === "灯楼"),
  false,
  "自检**不能**自己写词条：写权留在前台",
);
ok("a passing review stores the summary and only suggests new settings");

// ④ 坏形状 → inconclusive：不算通过、不加计数、也不清零
const attemptsBeforeBad = reviewMeta().review.attempts;
replyWith({ nonsense: true });
const badShape = await reviewCall({ chapter: reviewChapter, text: draft });
assert.equal(badShape.details.verdict, "inconclusive");
assert.equal(badShape.details.semantic_check, "failed");
assert.equal(badShape.details.attempts, attemptsBeforeBad, "基础服务故障不该改动连败计数");
assert.equal(reviewMeta().review.verdict, "inconclusive", "数据文件里不能写 pass（那是说谎）");
assert.ok(badShape.summary.includes("NOT a pass"), "必须明说这不是通过");

// 子 agent 起不来（比如 provider 报错）也走同一条降级路
subagentReply = { structured: undefined, output: [], stopReason: "error", diagnostic: "provider exploded" };
const errored = await reviewCall({ chapter: reviewChapter, text: draft });
assert.equal(errored.details.verdict, "inconclusive");
assert.ok(errored.summary.includes("provider exploded"), "故障原因要如实带出来");

// ⑤ 纯文本 JSON 兜底：结构化输出没调对时，不该整条链路判失败
replyText(`我的结论是 {"verdict":"fail","issues":["第二段重复了上一章的收尾"]} 请修改。`);
const fallback = await reviewCall({ chapter: reviewChapter, text: draft });
assert.equal(fallback.details.verdict, "fail", "文本兜底解析要能救回来");
assert.equal(fallback.details.attempts, 1);
ok("unusable and errored sub-agent runs degrade to inconclusive without touching the counter");

// ⑥ 连败到上限就停：不再建议重写，改为交给作者
replyWith({ verdict: "fail", issues: ["还是没推进"] });
const secondFail = await reviewCall({ chapter: reviewChapter, text: draft });
assert.equal(secondFail.details.attempts, 2);
assert.equal(secondFail.details.stop, false, "没到上限不该停");
const thirdFail = await reviewCall({ chapter: reviewChapter, text: draft });
assert.equal(thirdFail.details.attempts, 3);
assert.equal(thirdFail.details.stop, true, "默认上限 3：第三次就该停");
assert.ok(thirdFail.summary.includes("STOP"), "报告里要有明确的停");
assert.ok(/report the issues\s+above to the author/.test(thirdFail.summary), "要指向人而不是继续重写");
assert.ok(!thirdFail.summary.includes("Revise the chapter against these issues"), "停下时不该再给重写建议");

// ⑦ local_only：本地过了也只报 inconclusive，且**不动计数**（3 不能被清零）
const callsBeforeLocalOnly = reviewCalls.length;
const localOnly = await reviewCall({ chapter: reviewChapter, text: draft, local_only: true });
assert.equal(localOnly.details.verdict, "inconclusive");
assert.equal(localOnly.details.semantic_check, "local-only");
assert.equal(reviewCalls.length, callsBeforeLocalOnly, "local_only 不该起子 agent");
assert.equal(localOnly.details.attempts, 3, "本地过了不等于这一章合格，计数不能被清掉");
ok("consecutive failures stop at the limit, and local_only never clears them");

// ⑧ 审已经落盘的正文（不给 text）：材料来自文件，摘要写进那一章
replyWith({ verdict: "pass", issues: [], summary: "守夜人听见城墙外传来铃声。" });
const bodyReview = await reviewCall({ chapter: reviewFirst });
assert.equal(bodyReview.details.reviewed, "chapter body");
assert.equal(bodyReview.details.verdict, "pass");
assert.equal(firstMeta().summary, "守夜人听见城墙外传来铃声。");
ok("reviewing a landed chapter reads its body from disk");

// ── 第 6 步：词条注入的本地治理（排序 + 双上限 + 点名）与可选筛选
step("lorebook injection limits");
{
  const entries = await call("novel_lorebook", { action: "list", project: reviewProject });
  const longNight = entries.details.entries.find((entry) => entry.name === "长夜纪年");
  assert.ok(longNight, "示例词条应存在");

  // 可选的语义筛选：只准删。候选池外的 id 要被忽略并点名
  replyWith({ drop: [longNight.id, "根本不是候选池里的-id"] });
  const filtered = await call("novel_context", { project: reviewProject, chapter: reviewChapter, instruction: "写夜色", filter: true });
  const filterSpec = reviewCalls.at(-1);
  assert.deepEqual(filterSpec.request.toolFilter, { allow: [] }, "筛选子 agent 同样没有全局工具");
  assert.ok(filterSpec.request.prompt[0].text.includes("长夜纪年"), "候选条目要进筛选材料");
  assert.ok(!filtered.details.injected_entries.includes("长夜纪年"), "被删掉的条目不该再注入");
  assert.ok(filtered.summary.includes("not in the candidate list"), "候选池外的 id 要被点名忽略");

  // 筛选失败 → 候选全部保留（漏注入丢设定比多注入更糟）
  subagentReply = { structured: undefined, output: [], stopReason: "error", diagnostic: "filter down" };
  const unfiltered = await call("novel_context", { project: reviewProject, chapter: reviewChapter, instruction: "写夜色", filter: true });
  assert.ok(unfiltered.details.injected_entries.includes("长夜纪年"), "筛选失败要退回本地召回的结果");
  assert.ok(unfiltered.summary.includes("all candidates kept"), "要说清楚退回了");

  // 空正文 + 指令里提到关键词：也必须命中。
  // 现代卡的关键词几乎都是人名/功法/地名，第一次出现往往就在**指令**里；只看已写正文时，
  // 第一章（正文为空）永远匹配不到任何条目，整本关键词世界书等于全程静默（实测《道渊》就是）。
  await call("novel_lorebook", {
    action: "add",
    project: reviewProject,
    name: "换岗规矩",
    keys: "换岗",
    content: "换岗要敲三下灯楼。",
  });
  const emptyChapter = await call("novel_chapter", { action: "create", title: "空章", project: reviewProject });
  const emptyId = emptyChapter.details?.chapter?.id ?? emptyChapter.details?.chapter_id;
  const viaInstruction = await call("novel_context", {
    project: reviewProject,
    chapter: emptyId,
    instruction: "写一次换岗",
  });
  assert.ok(
    viaInstruction.details.injected_entries.includes("换岗规矩"),
    "空章节时，指令里的关键词也要命中",
  );
  ok("keyword matching sees the instruction (first chapter has no body yet)");
  // 条数上限：二十六个都命中「夜色」的词条，只注入 24 条，被砍的要**点名**
  for (let i = 0; i < 26; i++) {
    await call("novel_lorebook", {
      action: "add",
      name: `上限词条${i}`,
      keys: "夜色",
      content: `第 ${i} 条设定：夜色里不许点灯。`,
    });
  }
  const capped = await call("novel_context", { project: reviewProject, chapter: reviewChapter, instruction: "写夜色" });
  const keywordInjected = capped.details.injected_entries.filter((name) => name !== "灯火之界");
  assert.equal(keywordInjected.length, 24, "命中条目按条数封顶（默认 24）");
  assert.ok(capped.details.injected_entries.includes("灯火之界"), "常驻条目不占命中额度");
  assert.ok(capped.summary.includes("always-on (not capped)"), "常驻条目单独说明");
  assert.ok(capped.details.truncated_entries.length >= 2, "被砍的要如实报出数量");
  for (const name of capped.details.truncated_entries) {
    assert.ok(!capped.details.injected_entries.includes(name), `被砍的 ${name} 不该同时出现在注入清单里`);
  }
  assert.ok(capped.summary.includes("left out by the injection limits"), "简报里要点名被砍的条目");
  assert.ok(
    capped.details.truncated_entries.some((name) => capped.summary.includes(name)),
    "被砍的条目名字要出现在简报里（只说数量等于没说）",
  );

  // 相关度排序：命中两个关键词的排在命中一个的前面
  await call("novel_lorebook", {
    action: "add",
    name: "双命中条目",
    keys: "夜色, 城墙",
    content: "夜色里的城墙是唯一能叫醒守夜人的东西。",
  });
  const ranked = await call("novel_context", { project: reviewProject, chapter: reviewChapter, instruction: "写夜色" });
  const rankedAt = ranked.details.injected_entries.indexOf("双命中条目");
  const firstCapped = ranked.details.injected_entries.findIndex((name) => name.startsWith("上限词条"));
  assert.ok(rankedAt >= 0, "命中两个关键词的条目必须被注入");
  assert.ok(
    rankedAt < firstCapped,
    `命中更多关键词的条目应排在命中一个的前面（双命中在第 ${rankedAt + 1} 位，单命中最早的排在第 ${firstCapped + 1} 位）`,
  );
  ok("injection is ranked, capped, and names what it left out");
}

// ── 没有 subagents 服务时：只跑本地门槛，并且**明说**这不是通过 ──────────
// 这一条必须在**另一个** Context 里验：本进程那个已经 provide 了假服务，而"服务不在"
// 正是要验的分支（内核型组合里就没有那一行）。降级成静默"合格"是最坏的失败方式。

step("novel_review without a sub-agent service");
{
  const bare = new Context();
  await bare.plugin(SystemPrompt);
  await bare.plugin(ToolRuntime);
  await bare.plugin(LocalFileSystem, { cwd: workspace });
  await bare.plugin(SkillRegistry);
  const bareFiber = await bare.plugin(plugin, { dataDir: ".novelnovel" });
  const bareCall = async (name, args) =>
    bare.tools.get(name).execute(args, execFor(name, { ...args, project: reviewProject }));
  const outcome = await bareCall("novel_review", { chapter: reviewChapter });
  assert.equal(outcome.details.verdict, "inconclusive");
  assert.equal(outcome.details.semantic_check, "unavailable");
  assert.ok(outcome.summary.includes("UNAVAILABLE"), "要说清楚语义自检没跑");
  assert.ok(/NOT a pass/.test(outcome.summary), "必须提醒这不是通过");
  assert.equal(
    reviewMeta().review.attempts,
    3,
    "没有服务不该改动连败计数（基础设施故障不是这一章写坏了）",
  );
  assert.equal(reviewMeta().review.semantic, "unavailable");
  await bareFiber.dispose();
  ok("missing sub-agent service degrades to inconclusive instead of a silent pass");
}

// ── 资料源：独立世界书导入 → 拆解/分类/落盘/并入世界书（纯逻辑测不到"真落盘"这一层）
step("sources");
{
  // 四种条目各一条：常驻设定、关键词设定、MVU 规则、变量初值
  const bookPath = join(workspace, "book.json");
  writeFileSync(
    bookPath,
    JSON.stringify({
      entries: {
        0: { key: [], comment: "灯火之界", content: "灯灭则夜入。" },
        1: { key: ["长夜", "二十年"], comment: "长夜纪年", content: "长夜每二十年降临一次。" },
        2: { key: [], comment: "[mvu_update]", content: "每回合更新 世界.当前时间" },
        3: { key: [], comment: "[initvar] 初始", content: "世界:\n  当前时间: 未知" },
      },
    }),
    "utf8",
  );
  const before = (await call("novel_lorebook", { action: "list" })).details.entries.length;
  const importedSource = await call("novel_source", { action: "import", path: "book.json" });
  const counts = importedSource.details.counts;
  assert.equal(counts.state, 1, "初值条目应判成 state");
  assert.equal(counts.gameplay, 1, "MVU 规则条目应判成 gameplay");
  assert.equal(importedSource.details.merged.added, 3, "可注入通道 3 条（设定 2 + 玩法 1）");

  const after = (await call("novel_lorebook", { action: "list" })).details.entries.length;
  assert.equal(after - before, 3, "世界书应新增 3 条（state 不进世界书）");
  const loreNames = (await call("novel_lorebook", { action: "list" })).details.entries.map((e) => e.name);
  assert.ok(!loreNames.some((name) => name.includes("initvar")), "状态初值不能当词条混进世界书");

  const listed = await call("novel_source", { action: "list" });
  assert.ok(listed.summary.includes("世界书"), "列表里应能看到这个世界书源");
  const shown = await call("novel_source", { action: "show", source: importedSource.details.source.id });
  assert.ok(shown.summary.includes("通道明细"), "show 应给出通道明细");
  assert.ok(shown.summary.includes("状态初值"), "show 应标出状态初值");

  const disabled = await call("novel_source", { action: "disable", source: importedSource.details.source.id });
  assert.equal(disabled.details.source.enabled, false, "disable 应改到记录上");
  ok("world book import: classified into channels and merged with provenance");
}
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
