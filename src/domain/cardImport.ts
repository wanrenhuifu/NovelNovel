import { CharacterCard } from "@lenml/char-card-reader";
import type { CardFields, CardSpec, LoreEntry } from "./types";
import { replaceMacros } from "./prompt";

/**
 * 角色本体（字节版）：卡片字段 + 头像字节与媒体类型。
 * 头像以字节表达是刻意的——本包把头像直接写成项目目录里的图片文件，
 * 不需要 Blob 之类的内存存储形状。
 */
export interface ImportedCharacterBytes extends CardFields {
  avatarBytes: Uint8Array | null;
  avatarType: string;
  /**
   * 头像没能取到时说明原因（能取到时省略）。
   * 典型情况是 JSON 卡的 `avatar` 存的是外链 URL——本插件不联网抓取，
   * 不说明的话用户会以为头像导进来了，再导出却变成纯色占位图。
   */
  avatarNote?: string;
}

/** parseCharacterBytes 的完整返回：角色本体 + 世界书词条（id 留空，调用方生成） */
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
    const rawKeys = Array.isArray(e.keys)
      ? e.keys.filter((k): k is string => typeof k === "string")
      : typeof e.key === "string" && e.key.trim()
        ? [e.key]
        : [];
    // 关键词在项目里以「逗号分隔的字符串」存储、注入时按逗号切分，所以这里就把每个元素
    // 拆开并去空——否则 `["a,b"]` 会被当成两个键（放大命中面），
    // 而 `[" "]` 切完是空数组，该词条会**静默变成常驻注入**（每回合全文进提示词）。
    const keys = rawKeys
      .flatMap((key) => key.split(/[,，]/))
      .map((key) => key.trim())
      .filter(Boolean);
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
 * 从字节嗅探图片容器：只看魔数，不看文件名/媒体类型。
 * 用途是**避免拿图片去当 JSON 解析**——`.webp` 改名成 `.json` 时报
 * 「内容不是合法的 JSON」会把人带偏。
 */
function sniffImage(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) {
    return "image/png";
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46
  ) {
    return "image/webp";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  return undefined;
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
  const sniffed = sniffImage(bytes);
  const looksLikeJson =
    sniffed === undefined &&
    (filename.toLowerCase().endsWith(".json") || mediaType === "application/json");

  let card: CharacterCard;
  let avatarBytes: Uint8Array | null = null;
  let avatarType = "";
  let avatarNote: string | undefined;

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
    } else {
      avatarNote = avatarUrl
        ? "the card's avatar is an external URL (not inline data); this plugin does not fetch it, " +
          "so the export will use a solid-colour placeholder"
        : "the card carries no avatar image; the export will use a solid-colour placeholder";
    }
  } else {
    card = await CharacterCard.from_file(bytes);
    avatarBytes = bytes;
    avatarType = mediaType || sniffed || "image/png";
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
    ...(avatarNote !== undefined ? { avatarNote } : {}),
    specVersion: specToVersion(card.spec),
    rawData: JSON.stringify(card.raw_data),
    description: str(card.description),
    personality: str(card.personality),
    scenario: str(card.scenario),
    firstMes: str(card.first_message),
    mesExample: str(card.message_example),
    creatorNotes: str(data.creator_notes),
    creator: str(data.creator),
    lorebookEntriesInCard: Array.isArray(book?.entries) ? book.entries.length : 0,
    active: true,
    createdAt: Date.now(),
  };

  return { character, loreEntries: extractLorebookEntries(card) };
}
