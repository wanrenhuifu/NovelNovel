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
  const isV2 = spec === "chara_card_v2" || spec === "chara_card_v3";
  const rawData = ((raw.data ?? raw) as Record<string, unknown>) ?? {};
  const str = (value: unknown): string => (typeof value === "string" ? value : "");

  const data: Record<string, unknown> = isV2 ? { ...rawData } : { ...raw };
  data.name = character.name.trim() || str(rawData.name);
  data.description = character.description;
  data.personality = character.personality;
  data.scenario = character.scenario;
  data.first_mes = character.firstMes;
  data.mes_example = character.mesExample;
  data.creator_notes = character.creatorNotes;
  data.creator = character.creator;
  data.character_version = str(rawData.character_version);
  data.system_prompt = str(rawData.system_prompt);
  data.post_history_instructions = str(rawData.post_history_instructions);
  data.alternate_greetings = Array.isArray(rawData.alternate_greetings)
    ? rawData.alternate_greetings
    : [];
  data.tags = Array.isArray(rawData.tags) ? rawData.tags : [];
  data.extensions = (rawData.extensions as Record<string, unknown> | undefined) ?? {};

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
  const v2 = JSON.stringify(toV2Spec(character));
  const isV3 = character.specVersion === "v3";
  const v3 = isV3
    ? JSON.stringify({ ...JSON.parse(character.rawData), spec: "chara_card_v3", spec_version: "3.0" })
    : null;

  const cardChunks = [
    makeTextChunk("chara", toBase64(v2)),
    ...(v3 ? [makeTextChunk("ccv3", toBase64(v3))] : []),
  ];

  const withCard = (base: Uint8Array): Uint8Array<ArrayBuffer> => {
    const chunks = readPngChunks(base).filter((chunk) => {
      if (chunk.type !== "tEXt") return true;
      const parsed = parseTextChunk(chunk);
      const kw = parsed?.keyword.toLowerCase() ?? "";
      return kw !== "chara" && kw !== "ccv3";
    });
    const iendIndex = chunks.findIndex((c) => c.type === "IEND");
    return writePng([
      ...chunks.slice(0, iendIndex),
      ...cardChunks,
      ...chunks.slice(iendIndex),
    ]);
  };

  if (avatarBytes && isPng(avatarBytes)) return withCard(avatarBytes);
  return withCard(await makeSolidPng(512, 512, [38, 33, 29, 255]));
}
