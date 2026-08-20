import Dexie, { type Table } from "dexie";
import type {
  Chapter,
  Character,
  Project,
  AppSettings,
  ChatSession,
} from "../types";
import { defaultSettings } from "../types";

export class NovelDB extends Dexie {
  projects!: Table<Project, number>;
  chapters!: Table<Chapter, number>;
  characters!: Table<Character, number>;
  settings!: Table<AppSettings, number>;
  chatSessions!: Table<ChatSession, number>;

  constructor() {
    super("novelnovel");
    this.version(1).stores({
      projects: "++id, updatedAt",
      chapters: "++id, projectId, sortOrder, updatedAt",
      characters: "++id, projectId, name",
      settings: "id",
    });
    this.version(2)
      .stores({
        projects: "++id, updatedAt",
        chapters: "++id, projectId, sortOrder, updatedAt",
        characters: "++id, projectId, name",
        settings: "id",
      })
      .upgrade((tx) =>
        tx
          .table<Project, number>("projects")
          .toCollection()
          .modify((p) => {
            if (p.lorebook == null) p.lorebook = [];
          }),
      );
    // v3：聊天会话按项目持久化（projectId 为主键），旧库无需迁移
    this.version(3).stores({
      projects: "++id, updatedAt",
      chapters: "++id, projectId, sortOrder, updatedAt",
      characters: "++id, projectId, name",
      settings: "id",
      chatSessions: "projectId",
    });
  }
}

export const db = new NovelDB();

export async function getSettings(): Promise<AppSettings> {
  const s = await db.settings.get(1);
  // 以 defaultSettings 兜底，旧库记录自动补齐后续新增字段（如 presets）
  if (s) return { ...defaultSettings, ...s, id: 1 };
  const fresh: AppSettings = { ...defaultSettings, id: 1 };
  await db.settings.put(fresh);
  return fresh;
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await db.settings.put({ ...settings, id: 1 });
}
