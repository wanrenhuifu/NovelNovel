import { create } from "zustand";
import { db } from "../lib/db";
import type { Chapter, Project } from "../types";
import { computeReorder } from "../lib/reorder";

interface ProjectState {
  projects: Project[];
  chapters: Chapter[];
  activeProjectId: number | null;
  activeChapterId: number | null;
  loaded: boolean;

  loadAll: () => Promise<void>;
  createProject: (title: string) => Promise<number>;
  deleteProject: (id: number) => Promise<void>;
  updateProject: (id: number, patch: Partial<Project>) => Promise<void>;
  setActiveProject: (id: number | null) => Promise<void>;

  createChapter: (projectId: number, title?: string) => Promise<number>;
  renameChapter: (id: number, title: string) => Promise<void>;
  /** 给章节添加标签（重复标签忽略） */
  addChapterTag: (id: number, tag: string) => Promise<void>;
  /** 从章节移除标签 */
  removeChapterTag: (id: number, tag: string) => Promise<void>;
  deleteChapter: (id: number) => Promise<void>;
  /** 上移 / 下移章节（dir 为 -1 / 1） */
  moveChapter: (id: number, dir: -1 | 1) => Promise<void>;
  /** 拖拽章节到目标位置（position = before/after 目标 id） */
  reorderChapters: (
    dragId: number,
    targetId: number,
    position: "before" | "after",
  ) => Promise<void>;
  saveChapterContent: (id: number, content: string) => Promise<void>;
  setActiveChapter: (id: number | null) => Promise<void>;
}

async function loadChapters(projectId: number): Promise<Chapter[]> {
  return db.chapters
    .where("projectId")
    .equals(projectId)
    .sortBy("sortOrder");
}

export const useProjectStore = create<ProjectState>()((set, get) => ({
  projects: [],
  chapters: [],
  activeProjectId: null,
  activeChapterId: null,
  loaded: false,

  async loadAll() {
    const projects = await db.projects.orderBy("updatedAt").reverse().toArray();
    set({ projects, loaded: true });
    if (projects.length > 0 && get().activeProjectId === null) {
      await get().setActiveProject(projects[0].id!);
    }
  },

  async createProject(title) {
    const now = Date.now();
    const id = await db.projects.add({
      title: title.trim() || "未命名小说",
      synopsis: "",
      worldbuilding: "",
      authorNote: "",
      lorebook: [],
      createdAt: now,
      updatedAt: now,
    });
    await get().loadAll();
    await get().setActiveProject(id);
    const chapterId = await get().createChapter(id, "第一章");
    await get().setActiveChapter(chapterId);
    return id;
  },

  async deleteProject(id) {
    await db.chapters.where("projectId").equals(id).delete();
    await db.characters.where("projectId").equals(id).delete();
    await db.projects.delete(id);
    const remaining = get().projects.filter((p) => p.id !== id);
    set({ projects: remaining });
    if (get().activeProjectId === id) {
      await get().setActiveProject(remaining[0]?.id ?? null);
    }
  },

  async updateProject(id, patch) {
    await db.projects.update(id, { ...patch, updatedAt: Date.now() });
    set({
      projects: get().projects.map((p) =>
        p.id === id ? { ...p, ...patch, updatedAt: Date.now() } : p,
      ),
    });
  },

  async setActiveProject(id) {
    set({ activeProjectId: id, activeChapterId: null, chapters: [] });
    if (id == null) return;
    const chapters = await loadChapters(id);
    set({ chapters });
    if (chapters.length > 0) {
      set({ activeChapterId: chapters[0].id! });
    }
  },

  async createChapter(projectId, title) {
    const siblings = await loadChapters(projectId);
    const maxOrder = siblings.reduce((m, c) => Math.max(m, c.sortOrder), 0);
    const id = await db.chapters.add({
      projectId,
      title: title?.trim() || `第${siblings.length + 1}章`,
      content: "",
      sortOrder: maxOrder + 1,
      updatedAt: Date.now(),
      tags: [],
    });
    if (get().activeProjectId === projectId) {
      set({ chapters: await loadChapters(projectId) });
    }
    return id;
  },

  /** 给章节添加标签（重复标签忽略） */
  async addChapterTag(id, tag) {
    const trimmed = tag.trim();
    if (!trimmed) return;
    const chapter = await db.chapters.get(id);
    if (!chapter) return;
    if (chapter.tags.includes(trimmed)) return;
    await db.chapters.update(id, {
      tags: [...chapter.tags, trimmed],
      updatedAt: Date.now(),
    });
    const projectId = get().activeProjectId;
    if (projectId != null) set({ chapters: await loadChapters(projectId) });
  },

  /** 从章节移除标签 */
  async removeChapterTag(id, tag) {
    const chapter = await db.chapters.get(id);
    if (!chapter) return;
    await db.chapters.update(id, {
      tags: chapter.tags.filter((t) => t !== tag),
      updatedAt: Date.now(),
    });
    const projectId = get().activeProjectId;
    if (projectId != null) set({ chapters: await loadChapters(projectId) });
  },

  async renameChapter(id, title) {
    await db.chapters.update(id, { title: title.trim() || "未命名", updatedAt: Date.now() });
    const projectId = get().activeProjectId;
    if (projectId != null) set({ chapters: await loadChapters(projectId) });
  },

  async moveChapter(id, dir) {
    const projectId = get().activeProjectId;
    if (projectId == null) return;
    const list = await loadChapters(projectId);
    const idx = list.findIndex((c) => c.id === id);
    const target = idx + dir;
    if (idx < 0 || target < 0 || target >= list.length) return;
    // 交换相邻两章的 sortOrder
    await db.chapters.bulkPut([
      { ...list[idx], sortOrder: list[target].sortOrder },
      { ...list[target], sortOrder: list[idx].sortOrder },
    ]);
    set({ chapters: await loadChapters(projectId) });
  },

  async reorderChapters(dragId, targetId, position) {
    const projectId = get().activeProjectId;
    if (projectId == null) return;
    const list = await loadChapters(projectId);
    const reordered = computeReorder(list, dragId, targetId, position);
    if (!reordered) return;
    await db.chapters.bulkPut(reordered);
    set({ chapters: reordered });
  },

  async deleteChapter(id) {
    await db.chapters.delete(id);
    const projectId = get().activeProjectId;
    if (projectId == null) return;
    const chapters = await loadChapters(projectId);
    set({ chapters });
    if (get().activeChapterId === id) {
      set({ activeChapterId: chapters[0]?.id ?? null });
    }
  },

  async saveChapterContent(id, content) {
    const updatedAt = Date.now();
    await db.chapters.update(id, { content, updatedAt });
    // 同步刷新 store，否则续写取前文时会用到旧快照
    set({
      chapters: get().chapters.map((c) => (c.id === id ? { ...c, content, updatedAt } : c)),
    });
  },

  async setActiveChapter(id) {
    set({ activeChapterId: id });
    if (id == null) return;
    // 从数据库取最新内容，避免切回章节时用到内存里的旧快照
    const fresh = await db.chapters.get(id);
    if (fresh) {
      set({
        chapters: get().chapters.map((c) => (c.id === id ? fresh : c)),
      });
    }
  },
}));

export function useActiveProject(): Project | null {
  return useProjectStore(
    (s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null,
  );
}

export function useActiveChapter(): Chapter | null {
  return useProjectStore(
    (s) => s.chapters.find((c) => c.id === s.activeChapterId) ?? null,
  );
}
