import {
  readPngChunks,
  writePng,
  makeTextChunk,
  parseTextChunk,
  makeSolidPng,
  isPng,
} from "./png";
import type { CardSpec } from "./types";

/** 文件名里不能出现的字符（导出 md/txt/png 时用） */
export function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim() || "未命名";
}

/** 整书正文导出所需的最小章节形状（插件的章节对象即满足） */
export interface ExportableChapter {
  title: string;
  content: string;
}

/** 拼装整书 Markdown / TXT 文本（纯函数，不触存储） */
export function buildNovelDocument(
  project: { title: string; synopsis: string },
  chapters: ExportableChapter[],
  format: "md" | "txt",
): string {
  const parts: string[] = [];
  if (format === "md") {
    parts.push(`# ${project.title}`);
    if (project.synopsis.trim()) parts.push(`\n> ${project.synopsis.trim()}`);
    for (const ch of chapters) {
      parts.push(`\n## ${ch.title}\n\n${ch.content}`);
    }
  } else {
    parts.push(project.title);
    if (project.synopsis.trim()) parts.push(`\n${project.synopsis.trim()}`);
    for (const ch of chapters) {
      parts.push(`\n\n${ch.title}\n\n${ch.content}`);
    }
  }
  return parts.join("\n");
}

/** 角色卡导出所需的最小形状（StoredCharacter 即满足） */
export interface ExportableCharacter {
  name: string;
  specVersion: CardSpec;
  rawData: string;
  description: string;
  personality: string;
  scenario: string;
  firstMes: string;
  mesExample: string;
  creatorNotes: string;
  creator: string;
}

/**
 * 生成 V2 形状的导出 JSON。
 *
 * 存储字段是**权威**：`rawData` 只当未知键的底本。反过来（从 rawData 重建）会让
 * `novel_character action=update` 改过的名字/描述在导出时被悄悄换回旧值——
 * 「用本插件改了卡，再导回 SillyTavern 拿到旧名字」。
 *
 * V1 卡另有一层：rawData 里就是扁平字段，`creator_notes` / `creator` /
 * `character_version` 这些 V1 也有的字段要搬过来，不能凭空写成空串。
 */
function toV2Spec(character: ExportableCharacter): Record<string, unknown> {
  const raw = JSON.parse(character.rawData) as Record<string, unknown>;
  const spec = raw.spec;
  // 按**形状**判断 V2/V3（`data` 是对象），不看 `spec` 字面量：只写 `spec_version`、
  // 大小写不同或缺 `spec` 的卡会被误判成 V1，于是 `raw` 被整个摊进 `data`
  // （导出成 `data.data.…`）而真正的字段被埋掉。
  const v2Data =
    typeof raw.data === "object" && raw.data !== null ? (raw.data as Record<string, unknown>) : undefined;
  const isV2 = v2Data !== undefined;
  /**
   * `data` 的合并底本：V2/V3 用原 `data`，V1 用扁平的 `raw`。
   * 与 `source` 的区别很重要——底本决定"哪些未知键要保留"，而下面的字段**回退来源**必须
   * 两者都能落到（V1 的 `character_version` / `system_prompt` 就在扁平层，只看 V2 的 data
   * 会让 V1 卡往返时丢掉这两个字段）。
   */
  const base = isV2 ? (v2Data as Record<string, unknown>) : raw;
  const str = (value: unknown): string => (typeof value === "string" ? value : "");

  const pick = (key: string): unknown => base[key];
  const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

  const data: Record<string, unknown> = { ...base };
  data.name = character.name.trim() || str(pick("name"));
  data.description = character.description;
  data.personality = character.personality;
  data.scenario = character.scenario;
  data.first_mes = character.firstMes;
  data.mes_example = character.mesExample;
  data.creator_notes = character.creatorNotes;
  data.creator = character.creator;
  data.character_version = str(pick("character_version"));
  data.system_prompt = str(pick("system_prompt"));
  data.post_history_instructions = str(pick("post_history_instructions"));
  data.alternate_greetings = arr(pick("alternate_greetings"));
  data.tags = arr(pick("tags"));
  data.extensions = (pick("extensions") as Record<string, unknown> | undefined) ?? {};

  if (isV2) {
    return { ...raw, spec, data };
  }
  return { spec: "chara_card_v2", spec_version: "2.0", data };
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/**
 * 生成 SillyTavern 角色卡 PNG 字节（纯函数，不下载）：
 * 头像为 PNG 时改写其 tEXt（移除旧 chara/ccv3 后双写），否则生成纯色占位图。
 */
export async function buildCharacterPng(
  character: ExportableCharacter,
  avatarBytes: Uint8Array | null,
): Promise<Uint8Array<ArrayBuffer>> {
  const v2Spec = toV2Spec(character);
  const v2 = JSON.stringify(v2Spec);
  const isV3 = character.specVersion === "v3";
  // ccv3 的 data **复用合并后的那一份**（存储字段权威）。从 rawData 重建的话，
  // 同一个 PNG 里会出现 chara=新名、ccv3=旧名，而读取端 ccv3 优先 →
  // 用户用 novel_character 改过的字段在再导入时被悄悄换回旧值。
  const v3 = isV3
    ? JSON.stringify({
        ...(JSON.parse(character.rawData) as Record<string, unknown>),
        spec: "chara_card_v3",
        spec_version: "3.0",
        data: v2Spec.data,
      })
    : null;

  const cardChunks = [
    makeTextChunk("chara", toBase64(v2)),
    ...(v3 ? [makeTextChunk("ccv3", toBase64(v3))] : []),
  ];

  /**
   * 所有「卡片关键字」的 tEXt 都要剔除，不只是我们自己写的那两个。
   * 读取端认的 v1/v2 关键字里有老式的 `character_card`（还有 `ccv2`）：
   * 它们原封不动留在原位，而新写的 `chara` 插在 IEND 之前 → 读取端 `.find()` 命中靠前的旧 chunk，
   * 于是"导入 → 改名 → 导出 → 再导入"拿到的是旧卡，编辑全部丢失。
   */
  const CARD_KEYWORDS = new Set(["chara", "ccv3", "ccv2", "character_card"]);

  const withCard = (base: Uint8Array): Uint8Array<ArrayBuffer> => {
    const chunks = readPngChunks(base).filter((chunk) => {
      if (chunk.type !== "tEXt") return true;
      const parsed = parseTextChunk(chunk);
      const kw = parsed?.keyword.toLowerCase() ?? "";
      return !CARD_KEYWORDS.has(kw);
    });
    const iendIndex = chunks.findIndex((c) => c.type === "IEND");
    return writePng([
      ...chunks.slice(0, iendIndex),
      ...cardChunks,
      ...chunks.slice(iendIndex),
    ]);
  };

  const placeholder = async (): Promise<Uint8Array<ArrayBuffer>> =>
    withCard(await makeSolidPng(512, 512, [38, 33, 29, 255]));

  if (avatarBytes && isPng(avatarBytes)) {
    // 头像"看着像 PNG"（有魔数）不代表 chunk 结构完好。`readPngChunks` 对截断/长度越界的文件
    // 会抛错，而导入端（第三方库）遇到同样的问题只是停止读 chunk——
    // 于是同一份字节"能进不能出"，用户拿到一个没有头像的卡却不知道为什么。
    // 导出不该因为头像坏掉而整体失败：退回占位图，卡片数据仍然完整。
    try {
      return withCard(avatarBytes);
    } catch {
      return await placeholder();
    }
  }
  return await placeholder();
}
