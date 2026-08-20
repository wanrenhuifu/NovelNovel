import { CharacterCard } from "@lenml/char-card-reader";
import type { CardSpec, Character, LoreEntry } from "../types";
import { replaceMacros } from "./prompt";

/** 导入结果：不含 id 和 projectId，由调用方补齐后入库 */
export type ImportedCharacter = Omit<Character, "id" | "projectId">;

/** parseCharacterFile 的完整返回：角色本体 + 世界书词条（id 留空，调用方生成） */
export interface ParsedCharacter {
  character: ImportedCharacter;
  loreEntries: Omit<LoreEntry, "id">[];
}

/**
 * 提取角色卡内嵌世界书（character_book）为 lorebook 词条。
 * 兼容 keys 数组与旧式 key 单值；名称取 entry_name / name / comment，缺省回退首个关键词。
 * 词条来自特定角色卡，{{char}} 在此按来源卡名解析；项目 lorebook 混合多卡来源，
 * 若留到提示词组装时已无法确定 {{char}} 指向谁。
 */
export function extractLorebookEntries(
  card: CharacterCard,
): Omit<LoreEntry, "id">[] {
  const book = card.character_book as
    | { entries?: unknown[] }
    | null
    | undefined;
  if (!book || !Array.isArray(book.entries)) return [];
  const charName = card.name || "";

  return book.entries.flatMap((raw): Omit<LoreEntry, "id">[] => {
    if (typeof raw !== "object" || raw === null) return [];
    const e = raw as Record<string, unknown>;
    const content = typeof e.content === "string" ? e.content : "";
    if (!content.trim()) return []; // 空内容条目无注入价值
    const keys = Array.isArray(e.keys)
      ? e.keys.filter((k): k is string => typeof k === "string")
      : typeof e.key === "string" && e.key.trim()
        ? [e.key]
        : [];
    // SillyTavern 实际导出常把显示名放在 comment 字段
    const name =
      (typeof e.entry_name === "string" && e.entry_name.trim()) ||
      (typeof e.name === "string" && e.name.trim()) ||
      (typeof e.comment === "string" && e.comment.trim()) ||
      keys[0] ||
      "未命名词条";
    return [
      {
        name: replaceMacros(name, charName),
        // 关键词需保持原文用于上下文匹配，不替换宏
        keys: keys.join(", "),
        content: replaceMacros(content, charName),
        // 字段缺失视为启用，显式 false 才禁用
        enabled: e.enabled !== false,
      },
    ];
  });
}

function specToVersion(spec: unknown): CardSpec {
  if (spec === "chara_card_v3") return "v3";
  if (spec === "chara_card_v2") return "v2";
  return "v1";
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob | null> {
  try {
    const res = await fetch(dataUrl);
    return await res.blob();
  } catch {
    return null;
  }
}

/**
 * 从文件或 JSON 文本解析 SillyTavern 角色卡（兼容 V1/V2/V3）。
 * PNG/APNG/WebP/JPEG 会提取内嵌的 tEXt 数据（ccv3 优先于 chara）。
 * 同时提取内嵌世界书词条，供调用方合并进项目 lorebook。
 */
export async function parseCharacterFile(file: File): Promise<ParsedCharacter> {
  const buffer = await file.arrayBuffer();
  const looksLikeJson =
    file.name.toLowerCase().endsWith(".json") ||
    file.type === "application/json";

  let card: CharacterCard;
  let avatar: Blob | null = null;
  let avatarType = "";

  if (looksLikeJson) {
    const text = new TextDecoder("utf-8").decode(buffer);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("JSON 文件解析失败，内容不是合法的 JSON");
    }
    card = CharacterCard.from_json(json as never);
    const avatarUrl = await card.get_avatar(true);
    if (avatarUrl) {
      avatar = await dataUrlToBlob(avatarUrl);
      avatarType = avatarUrl.split(";")[0]?.replace("data:", "") || "";
    }
  } else {
    card = await CharacterCard.from_file(buffer);
    avatar = file;
    avatarType = file.type || "image/png";
  }

  const raw = card.raw_data as Record<string, unknown>;
  const data = ((raw.data ?? raw) as Record<string, unknown>) ?? {};
  const str = (v: unknown): string => (typeof v === "string" ? v : "");

  const book = card.character_book as
    | { entries?: unknown[] }
    | null
    | undefined;

  const character: ImportedCharacter = {
    name: card.name || "未命名角色",
    avatar,
    avatarType,
    specVersion: specToVersion(card.spec),
    rawData: JSON.stringify(card.raw_data),
    description: str(card.description),
    personality: str(card.personality),
    scenario: str(card.scenario),
    firstMes: str(card.first_message),
    mesExample: str(card.message_example),
    creatorNotes: str(data.creator_notes),
    creator: str(data.creator),
    lorebookCount: Array.isArray(book?.entries) ? book.entries.length : 0,
    active: true,
    createdAt: Date.now(),
  };

  return { character, loreEntries: extractLorebookEntries(card) };
}
