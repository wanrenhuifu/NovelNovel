import type { LoreEntry, Preset } from "../types";

/**
 * 提示词组装所需的最小项目/角色形状：浏览器端 Project/Character 天然满足，
 * dsh 插件端用自己的存储结构传入（文件系统里没有 id 主键与 Blob）。
 */
export interface PromptProject {
  title: string;
  synopsis: string;
  worldbuilding: string;
  authorNote: string;
  lorebook: LoreEntry[];
}

export interface PromptCharacter {
  name: string;
  description: string;
  personality: string;
  scenario: string;
}

/**
 * 替换 SillyTavern 常用宏。
 * {{char}} → 角色名；{{user}} → 主角名（小说场景下默认为“主角”）。
 */
export function replaceMacros(
  text: string,
  charName: string,
  userName = "主角",
): string {
  return text
    .replace(/\{\{char\}\}/gi, charName)
    .replace(/<BOT>/gi, charName)
    .replace(/\{\{user\}\}/gi, userName)
    .replace(/<USER>/gi, userName);
}

function characterBlock(char: PromptCharacter): string {
  const name = char.name;
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

/**
 * 挑出本次上下文要注入的词条：
 * 无关键词的条目常驻；有关键词的条目仅当任一关键词（逗号分隔、小写比较）
 * 出现在续写上下文里才注入。禁用或内容为空的条目一律排除。
 */
export function selectLoreEntries(
  entries: PromptProject["lorebook"],
  contextText: string,
): PromptProject["lorebook"] {
  const ctx = contextText.toLowerCase();
  return entries.filter((e) => {
    if (!e.enabled || !e.content.trim()) return false;
    const keys = e.keys
      .split(/[,，]/)
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean);
    if (keys.length === 0) return true; // 无关键词 = 常驻条目
    return keys.some((k) => ctx.includes(k));
  });
}

function lorebookBlock(
  entries: PromptProject["lorebook"],
  contextText: string,
): string | null {
  const active = selectLoreEntries(entries, contextText);
  if (active.length === 0) return null;
  const blocks = active
    .map((e) => `### ${e.name.trim() || e.keys}\n${e.content.trim()}`)
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
  contextText: string,
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
    wiBefore: lorebookBlock(project.lorebook ?? [], contextText) ?? "",
    wiAfter: "",
    persona: "",
    anchorBefore: "",
    anchorAfter: "",
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
 * 组装系统提示词：整合世界观、人物设定与写作要求。
 * characters 传入已勾选“参与写作”的角色。
 * contextText 用于激活 lorebook 中带关键词的条目（无关键词条目常驻）。
 * preset 激活时：systemPrompt 替换默认开场白（支持 {{char}}/{{user}} 宏），
 * storyString 替换默认的设定区块组装。
 */
export function buildSystemPrompt(
  project: PromptProject,
  characters: PromptCharacter[],
  contextText = "",
  preset?: Preset | null,
): string {
  const sections: string[] = [];
  const charName = characters[0]?.name ?? "";

  const intro = preset?.systemPrompt.trim();
  // 无参与角色时 {{char}} 宏替换为空串
  sections.push(
    intro ? replaceMacros(intro, charName).trim() : DEFAULT_INTRO(project.title),
  );

  if (preset?.storyString.trim()) {
    const vars = buildStoryVars(project, characters, contextText);
    sections.push(renderStoryString(preset.storyString, vars));
  } else {
    if (project.synopsis.trim()) {
      sections.push(`## 作品简介\n${project.synopsis.trim()}`);
    }
    if (project.worldbuilding.trim()) {
      sections.push(`## 世界观与背景\n${project.worldbuilding.trim()}`);
    }

    const lore = lorebookBlock(project.lorebook ?? [], contextText);
    if (lore) sections.push(lore);

    if (characters.length > 0) {
      const blocks = characters.map(characterBlock).join("\n\n");
      sections.push(`## 主要角色设定\n${blocks}`);
    }

    if (project.authorNote.trim()) {
      sections.push(`## 写作要求\n${project.authorNote.trim()}`);
    }
  }

  sections.push(OUTPUT_RULES);

  return sections.join("\n\n");
}

/** 前文章节摘录（续写上下文用） */
export interface PrevChapterExcerpt {
  title: string;
  text: string;
}

/**
 * 续写场景：把前文章节摘录、最近正文与指令拼成一条 user 消息。
 * 前文按传入顺序排列（由远及近），最后才是当前章节结尾。
 * 不带前文时输出与旧版完全一致（CONTINUE_SENTINEL 依赖此稳定性）。
 */
export function buildContinueUserMessage(
  recentText: string,
  instruction: string,
  prevChapters: PrevChapterExcerpt[] = [],
): string {
  const lines: string[] = [];
  const prev = prevChapters.filter((c) => c.text.trim());
  if (prev.length > 0) {
    lines.push("为保持情节连贯，以下是前面章节的结尾摘录，供参考：");
    for (const c of prev) {
      lines.push(`【${c.title.trim() || "前文章节"}】`, "```", c.text.trim(), "```");
    }
  }
  if (recentText.trim()) {
    lines.push("以下是当前章节已有正文的结尾部分，请从其后无缝续写：");
    lines.push("```");
    lines.push(recentText.trim());
    lines.push("```");
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
