/**
 * 资料源拆解与**通道分类**（纯逻辑：不 import harness、不碰文件系统）。
 *
 * 起因：现代社区角色卡不是"一个人"，而是一个可运行的世界模块。实测《道渊》v5.4.2（V3，10.25 MB）：
 *   description 297 字（封面语）· first_mes 18,650 字（整个开篇剧本）· character_book **356 条 /
 *   286,833 字**（卡的正文＝设定集）· extensions 里 6 段运行时脚本（MVU-offline + Zod + 1.03 MB
 *   悬浮状态栏）与 21 条正则。
 *
 * 卡里的世界书是**混排**的：设定、人物档案、程序化生成规则、变量更新规则写在同一本书里。
 * ST 的世界书只有"关键词/常驻"两档，没有"通道"概念——所以规则会和设定一起按关键词随机注入。
 * 这里给它加上通道：通道决定**怎么用**，而不是全塞进一个按运气抽的池子里。
 *
 * 分类必然有误判（卡作者不会按我们的分类写），所以每条都带 `reason`，并且**面板可逐条改**。
 */

import type { Channel } from "./types";

/** 通道定义在 domain/types.ts（domain 的基础类型层），这里转出去给外部用 */
export type { Channel };

/** 世界书里的一条，带上分类结果。 */
export interface ClassifiedEntry {
  name: string;
  keys: string;
  content: string;
  enabled: boolean;
  channel: Channel;
  /** 为什么判成这个通道（面板上显示，便于人纠正） */
  reason: string;
  /** ST 的 constant：有关键词也每回合都进 */
  constant?: boolean;
  /** ST 的 position：常驻块在角色设定之前/之后 */
  position?: "before_char" | "after_char";
}

/** 卡的元信息（不注入，供面板/详情用） */
export interface CardSourceMeta {
  name: string;
  specVersion: string;
  description: string;
  personality: string;
  scenario: string;
  firstMes: string;
  alternateGreetings: string[];
  tags: string[];
  creator: string;
  systemPrompt: string;
  postHistory: string;
  /** extensions 的顶层键与规模摘要（玩法运行时一般塞这里） */
  extensions: { path: string; detail: string }[];
  /** tavern_helper.scripts 之类：名字与字符数（**只读展示，不执行**） */
  scripts: { name: string; chars: number }[];
}

/** 一次拆解的结果。写盘形状见 `types.ts` 的 `StoredSource`。 */
export interface DecomposedSource {
  kind: "card" | "lore-book";
  name: string;
  meta: CardSourceMeta | null;
  entries: ClassifiedEntry[];
  /** gameplay 通道的条目原文拼接（规则区注入用） */
  rules: string;
  /** state 通道的条目原文（初值树等；解析成 JSON 是状态层的事） */
  initvarText: string;
  /** 丢弃/合并/不支持的说明，导入报告里逐条给人看 */
  notes: string[];
}

/** 通道的展示名（工具输出与面板共用一份） */
export const CHANNEL_LABEL: Record<Channel, string> = {
  lore: "设定",
  style: "文风",
  gameplay: "玩法",
  state: "状态",
  cast: "角色",
  material: "素材",
};

/** 会进世界书（可注入）的通道；`state` / `material` 只留在源里 */
export const INJECTABLE_CHANNELS: readonly Channel[] = ["lore", "style", "gameplay", "cast"];

const EMPTY = (text: string): boolean => text.trim() === "";

/**
 * 单条通道判定。**顺序有意义**：先认最具体的（MVU/初值/生成规则），再文学/人物，最后默认设定。
 *
 * 判据都留了 `reason`——这是"自动分类 + 人工纠正"的依据，不是黑盒打分。
 */
export function classifyEntry(name: string, content: string): { channel: Channel; reason: string } {
  const n = name.trim();
  const head = content.slice(0, 240);

  if (/^\[initvar\]|初始变量|变量列表/iu.test(n)) {
    return { channel: "state", reason: "名字是变量初值/变量索引" };
  }
  if (/\[mvu_update\]|mvu|变量更新/iu.test(n) || /变量更新规则|JSONPatch|UpdateVariable/.test(head)) {
    return { channel: "gameplay", reason: "MVU 变量更新规则" };
  }
  if (/生成|判定|骰|概率|奖励|掉落|DC ?总表|境界表/iu.test(n)) {
    return { channel: "gameplay", reason: "程序化规则/判定表" };
  }
  if (/状态栏|面板模板|样式模板|悬浮窗/iu.test(n)) {
    return { channel: "material", reason: "显示模板（不注入）" };
  }
  if (/文风|风格|叙事|笔法|人称|视角|语气|文笔/iu.test(n)) {
    return { channel: "style", reason: "写作风格指令" };
  }
  if (/^(人物|角色|NPC)/iu.test(n) || /\bNPC\b/iu.test(n)) {
    return { channel: "cast", reason: "人物档案" };
  }
  return { channel: "lore", reason: "默认按设定处理" };
}

/** 把已规整的条目（name/keys/content/enabled）分类；空内容条目会被丢弃并记一条 note。 */
export function classifyEntries(
  raw: {
    name: string;
    keys: string;
    content: string;
    enabled: boolean;
    constant?: boolean;
    position?: "before_char" | "after_char";
  }[],
  notes: string[],
): ClassifiedEntry[] {
  const out: ClassifiedEntry[] = [];
  for (const entry of raw) {
    if (EMPTY(entry.content)) {
      notes.push(`丢弃空条目「${entry.name || "(无名)"}」`);
      continue;
    }
    const { channel, reason } = classifyEntry(entry.name, entry.content);
    out.push({ ...entry, channel, reason });
  }
  return out;
}

/** 通道计数（导入报告/面板列表都用它） */
export function channelCounts(entries: { channel: Channel }[]): Record<Channel, number> {
  const counts: Record<Channel, number> = { lore: 0, style: 0, gameplay: 0, state: 0, cast: 0, material: 0 };
  for (const entry of entries) counts[entry.channel] += 1;
  return counts;
}

/** 把 gameplay 通道的条目拼成规则文本（规则区注入用） */
export function joinRules(entries: ClassifiedEntry[]): string {
  return entries
    .filter((entry) => entry.channel === "gameplay")
    .map((entry) => `## ${entry.name}\n${entry.content.trim()}`)
    .join("\n\n---\n\n");
}

/** state 通道原文（通常只有 `[initvar]` 一条） */
export function joinState(entries: ClassifiedEntry[]): string {
  return entries
    .filter((entry) => entry.channel === "state")
    .map((entry) => entry.content.trim())
    .join("\n\n");
}

/** 从卡的 rawData 里读那些我们的 `CardFields` 没提升为字段的东西 */
function readRawCard(rawData: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawData) as Record<string, unknown>;
    const data = parsed.data;
    return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : parsed;
  } catch {
    return {};
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** extensions 摘要：只报"有哪些键、多大"，不展开内容（1 MB 的脚本展开也没人看） */
function summarizeExtensions(extensions: unknown): { extensions: { path: string; detail: string }[]; scripts: { name: string; chars: number }[] } {
  const out: { path: string; detail: string }[] = [];
  const scripts: { name: string; chars: number }[] = [];
  if (typeof extensions !== "object" || extensions === null) return { extensions: out, scripts };
  for (const [key, value] of Object.entries(extensions as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      out.push({ path: key, detail: `数组 ${String(value.length)} 项` });
      if (key === "regex_scripts") out.push({ path: `${key}（正则，本插件不执行）`, detail: "仅保存" });
      continue;
    }
    if (typeof value === "object" && value !== null) {
      const keys = Object.keys(value as Record<string, unknown>);
      out.push({ path: key, detail: `对象 ${String(keys.length)} 键` });
      if (key === "tavern_helper") {
        const helper = value as Record<string, unknown>;
        for (const script of Array.isArray(helper.scripts) ? helper.scripts : []) {
          const record = script as Record<string, unknown>;
          const body = String(record.content ?? record.code ?? record.script ?? "");
          scripts.push({ name: String(record.name ?? "(未命名)"), chars: body.length });
        }
        const variables = helper.variables;
        if (typeof variables === "object" && variables !== null) {
          out.push({ path: `${key}.variables`, detail: `变量树 ${String(Object.keys(variables).length)} 个顶层键` });
        }
      }
      continue;
    }
    out.push({ path: key, detail: String(value).slice(0, 40) });
  }
  return { extensions: out, scripts };
}

/**
 * 拆一张卡。
 *
 * @param character 卡本体（`parseCharacterBytes` 的 `character`，含无损 `rawData`）
 * @param loreEntries 已规整的世界书条目（`parseCharacterBytes` 的 `loreEntries`，含空的 id 占位）
 */
export function decomposeCard(
  character: {
    name: string;
    specVersion: string;
    rawData: string;
    description: string;
    personality: string;
    scenario: string;
    firstMes: string;
    creatorNotes: string;
    creator: string;
    lorebookEntriesInCard: number;
  },
  loreEntries: {
    name: string;
    keys: string;
    content: string;
    enabled: boolean;
    constant?: boolean;
    position?: "before_char" | "after_char";
  }[],
): DecomposedSource {
  const notes: string[] = [];
  const raw = readRawCard(character.rawData);
  const { extensions, scripts } = summarizeExtensions(raw.extensions);

  const entries = classifyEntries(loreEntries, notes);
  const counts = channelCounts(entries);

  const systemPrompt = typeof raw.system_prompt === "string" ? raw.system_prompt : "";
  const postHistory = typeof raw.post_history_instructions === "string" ? raw.post_history_instructions : "";
  if (systemPrompt.trim() !== "" || postHistory.trim() !== "") {
    notes.push("卡自带 system_prompt / post_history_instructions：已存进源的卡面，不进简报（预设优先）");
  }
  if (entries.length !== character.lorebookEntriesInCard) {
    notes.push(
      `卡内世界书 ${String(character.lorebookEntriesInCard)} 条，实际保留 ${String(entries.length)} 条（空条目被丢弃）`,
    );
  }
  if (counts.gameplay > 0) notes.push(`判出 ${String(counts.gameplay)} 条玩法规则（常驻注入，不按关键词抽）`);
  if (counts.state > 0) notes.push(`判出 ${String(counts.state)} 条状态初值（进状态层，不进世界书）`);
  if (scripts.length > 0) {
    notes.push(
      `卡自带 ${String(scripts.length)} 段运行时脚本（${scripts.map((s) => s.name).join("、")}）：本插件**不执行**，仅只读保存`,
    );
  }

  return {
    kind: "card",
    name: character.name,
    meta: {
      name: character.name,
      specVersion: character.specVersion,
      description: character.description,
      personality: character.personality,
      scenario: character.scenario,
      firstMes: character.firstMes,
      alternateGreetings: stringList(raw.alternate_greetings),
      tags: stringList(raw.tags),
      creator: character.creator,
      systemPrompt,
      postHistory,
      extensions,
      scripts,
    },
    entries,
    rules: joinRules(entries),
    initvarText: joinState(entries),
    notes,
  };
}

/**
 * 解析一本**独立世界书**。接受两种形状：
 * - 本插件自己的 `LoreEntry[]`（或 `{ entries: [...] }`）
 * - SillyTavern World Info：`{ entries: { "0": { key: [...], content, comment, disable } } }`
 */
export function parseWorldBook(text: string): {
  name: string;
  entries: {
    name: string;
    keys: string;
    content: string;
    enabled: boolean;
    constant?: boolean;
    position?: "before_char" | "after_char";
  }[];
  notes: string[];
} {
  const notes: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`世界书不是合法 JSON：${(error as Error).message}`);
  }

  const toKeys = (value: unknown): string => {
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string").join(", ");
    if (typeof value === "string") return value;
    return "";
  };
  /**
   * `keys` 与 `key` 两份字段都可能存在，而实测《道渊》里 `key` 是**空数组**、真触发词在 `keys` 里。
   * 所以不能 `key ?? keys`（空数组不是 null，会取到空、丢掉全部关键词），要取**非空**的那个。
   */
  const pickKeys = (record: Record<string, unknown>): string => {
    const fromPlural = toKeys(record.keys);
    return fromPlural.trim() !== "" ? fromPlural : toKeys(record.key);
  };
  const pickName = (record: Record<string, unknown>, fallback: string): string => {
    for (const candidate of [record.comment, record.name, record.entry_name]) {
      if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
    }
    const keys = pickKeys(record);
    return keys === "" ? fallback : keys.split(",")[0].trim();
  };

  const bag: unknown = parsed;
  const rawEntries: {
    name: string;
    keys: string;
    content: string;
    enabled: boolean;
    constant?: boolean;
    position?: "before_char" | "after_char";
  }[] = [];

  const push = (record: unknown, fallbackName: string): void => {
    if (typeof record !== "object" || record === null) return;
    const entry = record as Record<string, unknown>;
    const content = typeof entry.content === "string" ? entry.content : "";
    if (content.trim() === "") return;
    const enabled = entry.disable === true ? false : entry.enabled === false ? false : true;
    rawEntries.push({
      name: pickName(entry, fallbackName),
      keys: pickKeys(entry),
      content,
      enabled,
      // 与卡导入同一套保真口径：constant / position 决定"每回合必进"与常驻块的位置
      ...(entry.constant === true ? { constant: true } : {}),
      ...(entry.position === "before_char" || entry.position === "after_char"
        ? { position: entry.position }
        : {}),
    });
  };

  if (Array.isArray(bag)) {
    bag.forEach((record, index) => push(record, `条目 ${String(index + 1)}`));
  } else if (typeof bag === "object" && bag !== null) {
    const record = bag as Record<string, unknown>;
    if (Array.isArray(record.entries)) {
      record.entries.forEach((item, index) => push(item, `条目 ${String(index + 1)}`));
    } else if (typeof record.entries === "object" && record.entries !== null) {
      for (const [key, item] of Object.entries(record.entries as Record<string, unknown>)) push(item, `条目 ${key}`);
    } else {
      throw new Error("认不出的世界书形状：既不是数组，也没有 entries");
    }
  } else {
    throw new Error("认不出的世界书形状");
  }

  if (rawEntries.length === 0) throw new Error("这本书里没有可用条目（内容全为空？）");
  notes.push(`解析到 ${String(rawEntries.length)} 条非空条目`);
  return { name: "世界书", entries: rawEntries, notes };
}

/** 导入报告（工具输出/面板提示共用一份格式） */
export function formatImportReport(source: DecomposedSource): string[] {
  const counts = channelCounts(source.entries);
  const parts = (Object.keys(counts) as Channel[])
    .filter((channel) => counts[channel] > 0)
    .map((channel) => `${CHANNEL_LABEL[channel]} ${String(counts[channel])} 条`);
  const lines = [
    `拆解结果：${parts.join(" · ") || "（没有条目）"}`,
    `进世界书（可注入）：${String(source.entries.filter((e) => INJECTABLE_CHANNELS.includes(e.channel)).length)} 条` +
      ` · 不进世界书：${String(source.entries.filter((e) => !INJECTABLE_CHANNELS.includes(e.channel)).length)} 条（状态/素材）`,
  ];
  if (source.rules.trim() !== "") lines.push(`规则区文本：${String(source.rules.length)} 字`);
  if (source.initvarText.trim() !== "") lines.push(`状态初值：${String(source.initvarText.length)} 字`);
  if (source.notes.length > 0) lines.push(...source.notes.map((note) => `· ${note}`));
  return lines;
}
