import { db } from "./db";
import {
  readPngChunks,
  writePng,
  makeTextChunk,
  parseTextChunk,
  makeSolidPng,
  isPng,
} from "./png";
import type { Character, Project } from "../types";

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

function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim() || "未命名";
}

/** 整本书导出为 Markdown / TXT 并下载 */
export async function exportNovel(
  project: Project,
  format: "md" | "txt",
): Promise<void> {
  const chapters = await db.chapters
    .where("projectId")
    .equals(project.id!)
    .sortBy("sortOrder");

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

  const blob = new Blob([parts.join("\n")], {
    type: format === "md" ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8",
  });
  downloadBlob(blob, `${safeName(project.title)}.${format}`);
}

/** 按角色原始 spec 生成 V2 形状的导出 JSON（V1 卡补一层包装） */
function toV2Spec(character: Character): Record<string, unknown> {
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

/**
 * 导出 SillyTavern 角色卡 PNG：
 * 头像为 PNG 时改写其 tEXt（移除旧 chara/ccv3 后双写），否则生成纯色占位图。
 */
export async function exportCharacterPng(character: Character): Promise<void> {
  const v2 = JSON.stringify(toV2Spec(character));
  const isV3 = character.specVersion === "v3";
  const v3 = isV3
    ? JSON.stringify({ ...JSON.parse(character.rawData), spec: "chara_card_v3", spec_version: "3.0" })
    : null;

  const toBase64 = (s: string) => {
    const bytes = new TextEncoder().encode(s);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  };

  const cardChunks = [
    makeTextChunk("chara", toBase64(v2)),
    ...(v3 ? [makeTextChunk("ccv3", toBase64(v3))] : []),
  ];

  let pngBytes: Uint8Array<ArrayBuffer>;
  let avatarBytes: Uint8Array | null = null;
  if (character.avatar) {
    avatarBytes = new Uint8Array(await character.avatar.arrayBuffer());
  }

  if (avatarBytes && isPng(avatarBytes)) {
    const chunks = readPngChunks(avatarBytes).filter((chunk) => {
      if (chunk.type !== "tEXt") return true;
      const parsed = parseTextChunk(chunk);
      const kw = parsed?.keyword.toLowerCase() ?? "";
      return kw !== "chara" && kw !== "ccv3";
    });
    const iendIndex = chunks.findIndex((c) => c.type === "IEND");
    pngBytes = writePng([
      ...chunks.slice(0, iendIndex),
      ...cardChunks,
      ...chunks.slice(iendIndex),
    ]);
  } else {
    const base = await makeSolidPng(512, 512, [38, 33, 29, 255]);
    const chunks = readPngChunks(base);
    const iendIndex = chunks.findIndex((c) => c.type === "IEND");
    pngBytes = writePng([
      ...chunks.slice(0, iendIndex),
      ...cardChunks,
      ...chunks.slice(iendIndex),
    ]);
  }

  const blob = new Blob([pngBytes], { type: "image/png" });
  downloadBlob(blob, `${safeName(character.name)}.png`);
}
