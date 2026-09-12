import {
  readPngChunks,
  writePng,
  makeTextChunk,
  parseTextChunk,
  makeSolidPng,
  isPng,
} from "./png";
import type { CardSpec, Character, Project } from "../types";

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim() || "未命名";
}

/** 整书正文导出所需的最小章节形状（浏览器端 Chapter、dsh 插件端章节都满足） */
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

/**
 * 整本书导出为 Markdown / TXT 并下载。
 * 章节由调用方传入（本模块不依赖存储层，dsh 插件端复用同一份拼装逻辑）。
 */
export function exportNovel(
  project: Project,
  chapters: ExportableChapter[],
  format: "md" | "txt",
): void {
  const text = buildNovelDocument(project, chapters, format);
  const blob = new Blob([text], {
    type: format === "md" ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8",
  });
  downloadBlob(blob, `${safeName(project.title)}.${format}`);
}

/** 角色卡导出所需的最小形状（浏览器端 Character、dsh 插件端存储结构都满足） */
export interface ExportableCharacter {
  name: string;
  specVersion: CardSpec;
  rawData: string;
}

/** 按角色原始 spec 生成 V2 形状的导出 JSON（V1 卡补一层包装） */
function toV2Spec(character: ExportableCharacter): Record<string, unknown> {
  const raw = JSON.parse(character.rawData) as Record<string, unknown>;
  if (raw.spec === "chara_card_v2" || raw.spec === "chara_card_v3") {
    return { ...raw, spec: "chara_card_v2", spec_version: "2.0" };
  }
  const legacy = raw as Record<string, string>;
  return {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name: legacy.name ?? character.name,
      description: legacy.description ?? "",
      personality: legacy.personality ?? "",
      scenario: legacy.scenario ?? "",
      first_mes: legacy.first_mes ?? "",
      mes_example: legacy.mes_example ?? "",
      creator_notes: "",
      system_prompt: "",
      post_history_instructions: "",
      alternate_greetings: [],
      tags: [],
      creator: "",
      character_version: "",
      extensions: {},
    },
  };
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

/**
 * 导出 SillyTavern 角色卡 PNG 并下载。
 * 头像非 PNG（或缺失）时用纯色占位图。
 */
export async function exportCharacterPng(character: Character): Promise<void> {
  const avatarBytes = character.avatar
    ? new Uint8Array(await character.avatar.arrayBuffer())
    : null;
  const pngBytes = await buildCharacterPng(character, avatarBytes);
  downloadBlob(
    new Blob([pngBytes], { type: "image/png" }),
    `${safeName(character.name)}.png`,
  );
}
