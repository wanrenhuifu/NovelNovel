import type { LoreEntry, Preset } from "./types";

/**
 * 提示词组装所需的最小项目/角色形状：调用方传自己的存储结构即可
 * （文件系统里没有数值主键，也不需要 Blob）。
 */
export interface PromptProject {
  title: string;
  synopsis: string;
  /**
   * 全书梗概（大纲第一层）。与 synopsis 同为必填 string，缺省由调用方 `?? ""` 归一；
   * 非空时**无条件**进系统提示词（见 buildSystemPrompt）。
   */
  outline: string;
  worldbuilding: string;
  authorNote: string;
  lorebook: LoreEntry[];
  /**
   * 状态层渲染后的文本（变量树 → 缩进列表）。**无条件**进简报：它和全书大纲一样是
   * "这本书当前的事实"，不能被 story_string 模板吞掉。
   */
  state?: string;
}

export interface PromptCharacter {
  name: string;
  description: string;
  personality: string;
  scenario: string;
}

/** 主角名（小说场景下的 {{user}} / <USER>） */
export const DEFAULT_USER_NAME = "主角";

/**
 * 替换 SillyTavern 常用宏。
 * {{char}} → 角色名；{{user}} → 主角名（小说场景下默认为"主角"）。
 *
 * 替换值一律用**函数形式**（`() => name`）：字符串形式的替换串里 `$&`、`$'`、`` $` ``、`$$`
 * 是特殊模式，而角色名是用户数据——名字里带 `$` 会把结果改写成乱码（实测 `A$'B` 会让
 * `{{char}}` 留在原地并把后半段复制一遍）。
 */
export function replaceMacros(
  text: string,
  charName: string,
  userName = DEFAULT_USER_NAME,
): string {
  return text
    .replace(/\{\{char\}\}/gi, () => charName)
    .replace(/<BOT>/gi, () => charName)
    .replace(/\{\{user\}\}/gi, () => userName)
    .replace(/<USER>/gi, () => userName);
}

/** 标题/名字进 `### ` 行时必须单行，否则会被当成新的提示词结构 */
function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 挑出模板真正引用的变量（{{var}} 与 {{#if var}}） */
function templateVars(template: string): Set<string> {
  const names = new Set<string>();
  for (const match of template.matchAll(/\{\{#if\s+(\w+)\s*\}\}/g)) names.add(match[1]);
  for (const match of template.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) names.add(match[1]);
  return names;
}

function characterBlock(char: PromptCharacter): string {
  const name = singleLine(char.name);
  const parts: string[] = [];
  if (char.description.trim()) {
    parts.push(replaceMacros(char.description, name).trim());
  }
  if (char.personality.trim()) {
    parts.push(`性格：${replaceMacros(char.personality, name).trim()}`);
  }
  if (char.scenario.trim()) {
    parts.push(`情境：${replaceMacros(char.scenario, name).trim()}`);
  }
  return `### ${name}\n${parts.join("\n")}`;
}

/** 关键词/上下文归一化：小写 + 全角转半角，避免「ＡＢＣ」「abc」「，」这类互不命中 */
function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, " ");
}

/**
 * 挑出本次上下文要注入的词条：
 * 无关键词的条目常驻；有关键词的条目仅当任一关键词（逗号分隔、大小写与全半角无关）
 * 出现在续写上下文里才注入。禁用或内容为空的条目一律排除。
 */
/**
 * 词条关键词的**读取**口径：按半角/全角逗号拆开、去空白、去空项。
 * `selectLoreEntries` 与写入侧的 `normalizeLoreKeys` 必须共用它，否则两侧会对
 * "这条有没有关键词"给出不同答案。
 */
export function splitLoreKeys(keys: string): string[] {
  return keys
    .split(/[,，]/)
    .map((k) => k.trim())
    .filter((k) => k !== "");
}

/**
 * 词条关键词的**写入**口径：规范化成「逗号 + 空格」分隔的规范形式。
 *
 * 为什么必须在写入时做：注入侧按 `[,，]` 拆分并把"拆完为空"当成**常驻注入**。
 * 于是 `keys = ",,"`、"、"、" , " 这类只有分隔符的输入会在列表里显示成"有关键词"，
 * 实际却每回合把整条内容注入提示词——用户以为它有条目条件，其实没有。
 * 规范化后这种输入变成空串，与"故意留空 = 常驻"是同一个显式状态。
 */
export function normalizeLoreKeys(keys: string): string {
  return splitLoreKeys(keys).join(", ");
}

/**
 * 选取要注入的词条：keys 为空 = 常驻注入；有关键词时仅当任一关键词
 * 出现在续写上下文里才注入。禁用或内容为空的条目一律排除。
 *
 * 这是**不设上限**的口径，用于「一共命中了几条」这类计数与老调用方；
 * 真正决定往简报里塞什么的，是 `rankLoreEntries`（排序 + 双上限）。
 */
export function selectLoreEntries(
  entries: PromptProject["lorebook"],
  contextText: string,
): PromptProject["lorebook"] {
  const ctx = normalizeForMatch(contextText);
  return entries.filter((e) => {
    if (!e.enabled || !e.content.trim()) return false;
    const keys = splitLoreKeys(e.keys).map((k) => normalizeForMatch(k)).filter(Boolean);
    if (keys.length === 0) return true; // 无关键词 = 常驻条目
    return keys.some((k) => ctx.includes(k));
  });
}

/**
 * 命中词条的注入上限（第 6 步的**本地治理**）。
 *
 * 为什么需要：`selectLoreEntries` 是「命中即注入」，一本书 200 条词条、某章同时提到
 * 城墙/祭司/夜祷时可能一次命中 30 条——全文进提示词，真正相关的那 5 条被淹掉
 * （docs/design/auto-writer.md §8.1 称之为「糊注入」）。
 *
 * 为什么是本地方案而不是起子 agent：这一层要**毫秒级、零 token、结果稳定**，
 * 它是每章都跑无数次的热路径。语义筛选作为**可选开关**存在（`novel_context filter=true`）。
 */
export interface LoreLimits {
  /** 命中条目的注入条数上限；<= 0 = 不限 */
  maxEntries: number;
  /** 命中条目的注入字符预算（按条目名 + 正文算）；<= 0 = 不限 */
  maxChars: number;
}

export const UNLIMITED_LORE: LoreLimits = { maxEntries: 0, maxChars: 0 };

/** 一次注入筛选的结果：四类各自独立，调用方按需要报给模型 */
export interface LoreSelection {
  /** 常驻条目（keys 为空）：作者显式要求每回合都带，**不占上限** */
  alwaysOn: PromptProject["lorebook"];
  /** 命中且真的进了简报的条目（按相关度降序） */
  injected: PromptProject["lorebook"];
  /** 命中但被上限砍掉的条目（按相关度降序）——调用方要**点名**，否则模型不知道还有它们 */
  truncated: PromptProject["lorebook"];
  /** 启用且内容非空、但关键词没出现在上下文里的条目 */
  skipped: PromptProject["lorebook"];
}

function matchedKeyCount(entry: PromptProject["lorebook"][number], ctx: string): number {
  return splitLoreKeys(entry.keys)
    .map((k) => normalizeForMatch(k))
    .filter(Boolean)
    .filter((k) => ctx.includes(k)).length;
}

/**
 * 命中条目按**相关度**（命中几个关键词）排序后按上限取前若干条。
 *
 * 两个刻意的口径：
 * - 同分按 id 稳定排序——否则同样输入下注入的内容会随词条文件顺序漂移，简报不可复现。
 * - **至少放进去一条**：单条词条就超过字符预算时也照放，否则"预算"会把设定整块清空，
 *   而模型拿不到任何设定比多花几百 token 更糟。
 */
export function rankLoreEntries(
  entries: PromptProject["lorebook"],
  contextText: string,
  limits: LoreLimits = UNLIMITED_LORE,
): LoreSelection {
  const ctx = normalizeForMatch(contextText);
  const alwaysOn: PromptProject["lorebook"] = [];
  const hits: { entry: PromptProject["lorebook"][number]; score: number }[] = [];
  const skipped: PromptProject["lorebook"] = [];
  for (const entry of entries) {
    if (!entry.enabled || !entry.content.trim()) continue;
    const keys = splitLoreKeys(entry.keys).map((k) => normalizeForMatch(k)).filter(Boolean);
    // 常驻有两种来源，语义都是"作者要求每回合都在"：
    //   ① ST 的 constant=true（**有关键词也常驻**，实测《道渊》56 条 / 6.3 万字）；
    //   ② 老口径：没有关键词（keys 空），无从触发，只能常驻。
    // 常驻**不占**关键词条目的预算（与 ST 一致：constant 条目不受 insert 预算约束）。
    if (entry.constant === true || keys.length === 0) {
      alwaysOn.push(entry);
      continue;
    }
    const score = matchedKeyCount(entry, ctx);
    if (score > 0) hits.push({ entry, score });
    else skipped.push(entry);
  }
  // 常驻块按 ST 的 position 排序（before_char 在前），同位置按 id 稳定排序——
  // 否则同样的词条文件会因读盘顺序不同而产出不同简报。
  alwaysOn.sort((a, b) => {
    const rank = (entry: PromptProject["lorebook"][number]): number =>
      entry.position === "before_char" ? 0 : 1;
    return rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  hits.sort(
    (a, b) => b.score - a.score || (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0),
  );
  const injected: PromptProject["lorebook"] = [];
  const truncated: PromptProject["lorebook"] = [];
  let chars = 0;
  for (const { entry } of hits) {
    const size = entry.name.length + entry.content.length;
    const overCount = limits.maxEntries > 0 && injected.length >= limits.maxEntries;
    const overChars = limits.maxChars > 0 && injected.length > 0 && chars + size > limits.maxChars;
    if (overCount || overChars) {
      truncated.push(entry);
      continue;
    }
    injected.push(entry);
    chars += size;
  }
  return { alwaysOn, injected, truncated, skipped };
}

function loreBlockFromSelection(selection: LoreSelection): string | null {
  const active = [...selection.alwaysOn, ...selection.injected];
  if (active.length === 0) return null;
  const blocks = active
    .map((e) => `### ${singleLine(e.name.trim() || e.keys)}\n${e.content.trim()}`)
    .join("\n\n");
  return `## 相关设定词条\n${blocks}`;
}

/**
 * 渲染 SillyTavern context 模板的 story_string。
 * 仅支持模板实际用到的子集：{{#if var}}…{{/if}}、{{var}}、{{trim}}。
 * 未知变量按空串处理（与 SillyTavern 的 Handlebars 行为一致）。
 */
export function renderStoryString(
  template: string,
  vars: Record<string, string>,
): string {
  let out = template;
  // body 排除 {{#if 保证每次先匹配最内层块，嵌套时不会残留孤儿 {{/if}}
  const ifRe = /\{\{#if\s+(\w+)\s*\}\}((?:(?!\{\{#if\b)[\s\S])*?)\{\{\/if\}\}/g;
  let prev = "";
  while (prev !== out) {
    prev = out;
    out = out.replace(ifRe, (_m, name: string, body: string) => {
      const val = vars[name] ?? "";
      // 只认最外层 {{else}}（嵌套场景极少，够用）
      const parts = body.split("{{else}}");
      return val.trim() ? (parts[0] ?? "") : (parts[1] ?? "");
    });
  }
  out = out.replace(/\{\{trim\}\}/g, "");
  out = out.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, name: string) => vars[name] ?? "");
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/** story_string 可用变量：卡片字段按角色聚合并替换宏 */
function buildStoryVars(
  project: PromptProject,
  characters: PromptCharacter[],
  lore: LoreSelection,
): Record<string, string> {
  const join = (get: (c: PromptCharacter) => string): string =>
    characters
      .map((c) => replaceMacros(get(c), c.name).trim())
      .filter(Boolean)
      .join("\n\n");
  return {
    title: project.title.trim(),
    synopsis: project.synopsis.trim(),
    worldbuilding: project.worldbuilding.trim(),
    // SillyTavern 模板里的 system 位对应本应用的“写作要求”
    system: project.authorNote.trim(),
    description: join((c) => c.description),
    personality: join((c) => c.personality),
    scenario: join((c) => c.scenario),
    // 本应用 lorebook 不区分插入位置，统一放 wiBefore
    wiBefore: loreBlockFromSelection(lore) ?? "",
    wiAfter: "",
    persona: "",
    anchorBefore: "",
    anchorAfter: "",
    // SillyTavern 模板会写 {{char}}/{{user}}。systemPrompt 那条路径走 replaceMacros，
    // 这里不放进变量表的话 `?? ""` 会把它们静默替成空串（`{{#if char}}` 恒假）。
    char: characters[0] ? singleLine(characters[0].name) : "",
    user: DEFAULT_USER_NAME,
  };
}

const DEFAULT_INTRO = (title: string): string =>
  `你是一位专业的中文小说创作者，正在创作长篇小说《${title}》。` +
  `请依据下方设定进行续写或改写，保持人物性格一致、叙事连贯、文笔流畅。`;

const OUTPUT_RULES = [
  "## 输出规范",
  "- 直接输出小说正文，不要输出任何解释、前言或元评论。",
  "- 保持与已有正文一致的叙事视角、时态与文风。",
  "- 人物言行须符合其设定，避免性格漂移。",
].join("\n");

/**
 * 组装系统提示词：整合全书大纲、世界观、人物设定与写作要求。
 * characters 传入已勾选“参与写作”的角色。
 * contextText 用于激活 lorebook 中带关键词的条目（无关键词条目常驻）。
 * preset 激活时：systemPrompt 替换默认开场白（支持 {{char}}/{{user}} 宏），
 * storyString 替换默认的设定区块组装；`project.outline` **不受它影响**（见下）。
 *
 * 返回值带 `warnings`：story_string 是「整块替换」，模板引用了某个变量而它是空的时候
 * （最常见的 `{{wiAfter}}`——本应用把词条统一放在 wiBefore），那段设定就**不会**进提示词。
 * 静默降级最难查，所以把它报出来。
 */
export function buildSystemPrompt(
  project: PromptProject,
  characters: PromptCharacter[],
  contextText = "",
  preset?: Preset | null,
  loreSelection?: LoreSelection,
): { text: string; warnings: string[]; lore: LoreSelection } {
  const sections: string[] = [];
  const warnings: string[] = [];
  const charName = characters[0]?.name ?? "";
  // 不传就用「不限上限」的本地筛选——与实现第 6 步之前逐字相同，老调用方/单测不受影响。
  // 生产路径（novel_context）显式传自己算好的 selection，因为那层还要叠加 agent 筛选。
  const lore = loreSelection ?? rankLoreEntries(project.lorebook ?? [], contextText);

  const intro = preset?.systemPrompt.trim();
  // 无参与角色时 {{char}} 宏替换为空串
  sections.push(
    intro ? replaceMacros(intro, charName).trim() : DEFAULT_INTRO(project.title),
  );

  // story_string 是「整块替换设定」，但它**不决定有没有全书大纲**（见下）。
  // 这里保留原串而不是 trim 结果：renderStoryString 自己会 trim，传入更动的模板没有收益。
  const storyTemplate = preset?.storyString.trim() ? preset.storyString : "";
  const outline = (project.outline ?? "").trim();

  if (!storyTemplate && project.synopsis.trim()) {
    // 作品简介先于全书大纲：全书方向先于局部设定。story_string 路径整块替换设定，没有这一位。
    sections.push(`## 作品简介\n${project.synopsis.trim()}`);
  }
  // 全书大纲（大纲第一层，300–800 字）**无条件附带**：它刻意放在 story_string 的 if / else
  // **之外**。理由是两者的性质不同——预设的 story_string 管的是**文风与设定怎么呈现**，
  // 而全书大纲是**这本书的事实**；设计文档把它归为「不可遗漏」的 Push 层
  // （docs/design/auto-writer.md §4），所以不能被一个没引用它的模板悄悄丢掉。
  // 为空串（含老作品没有这个字段）时这里什么都不做，输出与旧版逐字相同。
  if (outline) {
    sections.push(`## 全书大纲\n${outline}`);
  }

  if (storyTemplate) {
    const vars = buildStoryVars(project, characters, lore);
    sections.push(renderStoryString(storyTemplate, vars));
    // 模板引用了却没有内容的变量 = 这段设定不会进提示词
    const empty = [...templateVars(storyTemplate)].filter((name) => {
      if (name === "trim" || name === "else") return false;
      return !(vars[name] ?? "").trim();
    });
    if (empty.length > 0) {
      warnings.push(
        `the active preset's story_string references ${empty.map((n) => `{{${n}}}`).join(", ")} ` +
          "but there is nothing to fill it with, so that part of the brief is empty. " +
          "Check the preset template and the project's worldbuilding / character cards.",
      );
    }
  } else {
    if (project.worldbuilding.trim()) {
      sections.push(`## 世界观与背景\n${project.worldbuilding.trim()}`);
    }

    const block = loreBlockFromSelection(lore);
    if (block) sections.push(block);

    if (characters.length > 0) {
      const blocks = characters.map(characterBlock).join("\n\n");
      sections.push(`## 主要角色设定\n${blocks}`);
    }

    if (project.authorNote.trim()) {
      sections.push(`## 写作要求\n${project.authorNote.trim()}`);
    }
  }

  // 状态层：刻意放在 story_string 的 if/else **之外**。
  // 模板管的是"设定怎么呈现"，而状态是模型必须维持的事实（时间/地点/生命/储物袋…），
  // 一个没引用它的模板不该让状态从简报里消失。
  if ((project.state ?? "").trim() !== "") {
    sections.push(`## 当前状态\n${(project.state ?? "").trim()}`);
  }

  sections.push(OUTPUT_RULES);

  return { text: sections.join("\n\n"), warnings, lore };
}

/** 前文章节摘录（续写上下文用） */
export interface PrevChapterExcerpt {
  title: string;
  text: string;
}

/**
 * 围栏长度：正文里出现一行 ``` 就会提前闭合围栏，把后面的文本放到栏外
 * （prompt 注入）。所以围栏至少比正文里最长的一串反引号长一个。
 *
 * 导出给 `domain/review.ts`：自检子 agent 的提示词里同样要包正文。
 */
export function fenceFor(body: string): string {
  const longest = [...body.matchAll(/`+/g)].reduce((max, m) => Math.max(max, m[0].length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * 续写场景：把前文章节摘录、最近正文与指令拼成一条 user 消息。
 * 前文按传入顺序排列（由远及近），最后才是当前章节结尾。
 *
 * `chapterGoal` 是本章要推进什么（大纲第三层）：它**必须单独走这条路**——
 * `buildSystemPrompt` 收不到章节元数据。放在指令块最前，作为"这一轮要写什么"的框架，
 * 紧跟其后的才是本轮的具体要求。传空串（或缺失）时输出与旧版**逐字相同**
 * （CONTINUE_SENTINEL 依赖此稳定性）。
 */
export function buildContinueUserMessage(
  recentText: string,
  instruction: string,
  prevChapters: PrevChapterExcerpt[] = [],
  chapterGoal = "",
): string {
  const lines: string[] = [];
  const prev = prevChapters.filter((c) => c.text.trim());
  if (prev.length > 0) {
    lines.push("为保持情节连贯，以下是前面章节的结尾摘录，供参考：");
    for (const c of prev) {
      const text = c.text.trim();
      const fence = fenceFor(text);
      lines.push(`【${singleLine(c.title) || "前文章节"}】`, fence, text, fence);
    }
  }
  if (recentText.trim()) {
    const text = recentText.trim();
    const fence = fenceFor(text);
    lines.push("以下是当前章节已有正文的结尾部分，请从其后无缝续写：");
    lines.push(fence);
    lines.push(text);
    lines.push(fence);
  }
  const goal = chapterGoal.trim();
  if (goal) {
    lines.push(`本章目标：${goal}`);
  }
  if (instruction.trim()) {
    lines.push(`续写要求：${instruction.trim()}`);
  } else {
    lines.push("请直接续写接下来的情节。");
  }
  return lines.join("\n\n");
}

/**
 * 按轮数截断聊天历史：最多保留最近 maxTurns 轮
 * （一条 user 消息及其后续 assistant 回复算一轮，从 user 消息处截断保证配对完整）。
 * maxTurns <= 0 表示全部携带。
 */
export function trimChatHistory<T extends { role: string }>(
  history: T[],
  maxTurns: number,
): T[] {
  if (maxTurns <= 0) return history;
  let userCount = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "user") {
      userCount++;
      if (userCount >= maxTurns) return history.slice(i);
    }
  }
  return history;
}
