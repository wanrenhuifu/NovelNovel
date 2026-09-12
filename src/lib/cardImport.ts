import { CharacterCard } from "@lenml/char-card-reader";
import type { CardSpec, Character, LoreEntry } from "../types";
import { replaceMacros } from "./prompt";

/** 导入结果：不含 id 和 projectId，由调用方补齐后入库 */
export type ImportedCharacter = Omit<Character, "id" | "projectId">;

/**
 * 角色本体（字节版）：头像以字节 + 媒体类型表达——浏览器端转 Blob 入库，
 * dsh 插件端直接写 PNG 文件。其余字段与 ImportedCharacter 完全一致。
 */
export interface ImportedCharacterBytes
  extends Omit<ImportedCharacter, "avatar" | "avatarType"> {
  avatarBytes: Uint8Array | null;
  avatarType: string;
}

/** parseCharacterFile 的完整返回：角色本体 + 世界书词条（id 留空，调用方生成） */
export interface ParsedCharacter {
  character: ImportedCharacter;
  loreEntries: Omit<LoreEntry, "id">[];
}

/** parseCharacterBytes 的完整返回 */
export interface ParsedCharacterBytes {
  character: ImportedCharacterBytes;
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

/** data URL → 字节 + 媒体类型；非 base64 data URL 返回 null */
function dataUrlToBytes(
  dataUrl: string,
): { bytes: Uint8Array; mediaType: string } | null {
  const comma = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:") || comma < 0) return null;
  const header = dataUrl.slice("data:".length, comma);
  if (!/;base64/i.test(header)) return null;
  try {
    const binary = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return {
      bytes,
      mediaType: header.replace(/;base64/i, "") || "application/octet-stream",
    };
  } catch {
    return null;
  }
}

/**
 * 从字节解析 SillyTavern 角色卡（兼容 V1/V2/V3）。
 * PNG/APNG/WebP/JPEG 会提取内嵌的 tEXt 数据（ccv3 优先于 chara）。
 * 同时提取内嵌世界书词条，供调用方合并进项目 lorebook。
 */
export async function parseCharacterBytes(
  bytes: Uint8Array,
  filename: string,
  mediaType = "",
): Promise<ParsedCharacterBytes> {
  const looksLikeJson =
    filename.toLowerCase().endsWith(".json") ||
    mediaType === "application/json";

  let card: CharacterCard;
  let avatarBytes: Uint8Array | null = null;
  let avatarType = "";

  if (looksLikeJson) {
    const text = new TextDecoder("utf-8").decode(bytes);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("JSON 文件解析失败，内容不是合法的 JSON");
    }
    card = CharacterCard.from_json(json as never);
    const avatarUrl = await card.get_avatar(true);
    const decoded = avatarUrl ? dataUrlToBytes(avatarUrl) : null;
    if (decoded) {
      avatarBytes = decoded.bytes;
      avatarType = decoded.mediaType;
    }
  } else {
    card = await CharacterCard.from_file(bytes);
    avatarBytes = bytes;
    avatarType = mediaType || "image/png";
  }

  const raw = card.raw_data as Record<string, unknown>;
  const data = ((raw.data ?? raw) as Record<string, unknown>) ?? {};
  const str = (v: unknown): string => (typeof v === "string" ? v : "");

  const book = card.character_book as
    | { entries?: unknown[] }
    | null
    | undefined;

  const character: ImportedCharacterBytes = {
    name: card.name || "未命名角色",
    avatarBytes,
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

/**
 * 从文件或 JSON 文本解析 SillyTavern 角色卡（兼容 V1/V2/V3）。
 * parseCharacterBytes 的浏览器包装：头像转成 Blob 供 IndexedDB 存储。
 */
export async function parseCharacterFile(file: File): Promise<ParsedCharacter> {
  const parsed = await parseCharacterBytes(
    new Uint8Array(await file.arrayBuffer()),
    file.name,
    file.type,
  );
  const { avatarBytes, ...rest } = parsed.character;
  return {
    character: {
      ...rest,
      avatar:
        avatarBytes && avatarBytes.length > 0
          ? new Blob([new Uint8Array(avatarBytes)], {
              type: parsed.character.avatarType || "image/png",
            })
          : null,
      avatarType: parsed.character.avatarType,
    },
    loreEntries: parsed.loreEntries,
  };
}
