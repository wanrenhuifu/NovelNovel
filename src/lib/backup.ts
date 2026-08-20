import { db, getSettings } from "./db";
import { downloadBlob } from "./export";
import { blobToDataURL } from "./utils";
import type {
  AppSettings,
  Chapter,
  Character,
  Project,
} from "../types";

/** 角色头像在 JSON 备份中以 data URL 存放 */
type SerializedCharacter = Omit<Character, "avatar"> & {
  avatar: string | null;
};

interface BackupFile {
  format: "novelnovel-backup";
  version: 1;
  exportedAt: number;
  data: {
    projects: Project[];
    chapters: Chapter[];
    characters: SerializedCharacter[];
    settings: AppSettings | null;
  };
}

export interface ImportSummary {
  projects: number;
  chapters: number;
  characters: number;
}

function dataURLToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("头像数据格式不正确");
  const head = dataUrl.slice(0, comma);
  const base64 = dataUrl.slice(comma + 1);
  const mime = /data:([^;]+)/.exec(head)?.[1] ?? "application/octet-stream";
  const bin = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** 导出全部数据为 JSON 备份文件（含 API Key，请妥善保管） */
export async function exportBackup(): Promise<void> {
  const [projects, chapters, rawCharacters, settings] = await Promise.all([
    db.projects.toArray(),
    db.chapters.toArray(),
    db.characters.toArray(),
    getSettings(),
  ]);

  const characters: SerializedCharacter[] = await Promise.all(
    rawCharacters.map(async (c) => ({
      ...c,
      avatar: c.avatar ? await blobToDataURL(c.avatar) : null,
    })),
  );

  const backup: BackupFile = {
    format: "novelnovel-backup",
    version: 1,
    exportedAt: Date.now(),
    data: { projects, chapters, characters, settings },
  };

  const blob = new Blob([JSON.stringify(backup, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const date = new Date()
    .toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })
    .replace(/\//g, "-");
  downloadBlob(blob, `novelnovel-backup-${date}.json`);
}

/** 导入备份：清空现有数据后整体恢复（不可撤销，调用方需先确认） */
export async function importBackup(file: File): Promise<ImportSummary> {
  const text = await file.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("文件不是有效的 JSON");
  }

  const backup = parsed as Partial<BackupFile>;
  if (backup?.format !== "novelnovel-backup" || !backup.data) {
    throw new Error("不是 NovelNovel 备份文件（缺少格式标记）");
  }
  const { projects, chapters, characters, settings } = backup.data;
  if (
    !Array.isArray(projects) ||
    !Array.isArray(chapters) ||
    !Array.isArray(characters)
  ) {
    throw new Error("备份文件内容不完整或已损坏");
  }

  const restoredCharacters: Character[] = characters.map((c) => ({
    ...c,
    avatar: c.avatar ? dataURLToBlob(c.avatar) : null,
  }));

  // 单事务内清空再写入，避免中途失败留下半套数据
  await db.transaction("rw", db.projects, db.chapters, db.characters, db.settings, async () => {
    await Promise.all([
      db.projects.clear(),
      db.chapters.clear(),
      db.characters.clear(),
      db.settings.clear(),
    ]);
    await db.projects.bulkPut(projects);
    await db.chapters.bulkPut(chapters);
    await db.characters.bulkPut(restoredCharacters);
    if (settings) await db.settings.put({ ...settings, id: 1 });
  });

  return {
    projects: projects.length,
    chapters: chapters.length,
    characters: restoredCharacters.length,
  };
}
