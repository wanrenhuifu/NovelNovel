import { create } from "zustand";
import { db } from "../lib/db";
import { parseCharacterFile } from "../lib/cardImport";
import { uid } from "../lib/utils";
import type { Character, LoreEntry } from "../types";

/** 导入一个文件的产物：入库后的角色 + 世界书词条（已生成 id，待并入项目 lorebook） */
export interface ImportResult {
  character: Character;
  loreEntries: LoreEntry[];
}

interface CharacterState {
  characters: Character[];
  /** 当前项目 id，切换项目时刷新 */
  projectId: number | null;
  loadForProject: (projectId: number) => Promise<void>;
  clear: () => void;
  importFile: (file: File) => Promise<ImportResult>;
  remove: (id: number) => Promise<void>;
  toggleActive: (id: number) => Promise<void>;
}

export const useCharacterStore = create<CharacterState>()((set, get) => ({
  characters: [],
  projectId: null,

  async loadForProject(projectId) {
    const characters = await db.characters
      .where("projectId")
      .equals(projectId)
      .toArray();
    set({ characters, projectId });
  },

  clear() {
    set({ characters: [], projectId: null });
  },

  async importFile(file) {
    const projectId = get().projectId;
    if (projectId == null) throw new Error("请先选择小说项目");
    const { character: imported, loreEntries } = await parseCharacterFile(file);
    const id = await db.characters.add({ ...imported, projectId });
    const character = { ...imported, projectId, id };
    set({ characters: [...get().characters, character] });
    // 词条 id 在此生成，入库与并入项目 lorebook 由调用方完成
    return {
      character,
      loreEntries: loreEntries.map((e) => ({ ...e, id: uid() })),
    };
  },

  async remove(id) {
    await db.characters.delete(id);
    set({ characters: get().characters.filter((c) => c.id !== id) });
  },

  async toggleActive(id) {
    const target = get().characters.find((c) => c.id === id);
    if (!target) return;
    const active = !target.active;
    await db.characters.update(id, { active });
    set({
      characters: get().characters.map((c) =>
        c.id === id ? { ...c, active } : c,
      ),
    });
  },
}));
