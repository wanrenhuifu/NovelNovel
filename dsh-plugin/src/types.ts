/**
 * 插件持久化结构：数据以「人可读、agent 可直改」的文件形式落在工作目录下。
 *
 * <工作目录>/<dataDir>/                     默认 .novelnovel
 *   workspace.json                          { version, activeProject }
 *   projects/<projectId>/
 *     project.json                          作品元数据
 *     lorebook.json                         LoreEntry[]
 *     presets.json                          { activePresetId, presets }
 *     chapters/index.json                   { items: ChapterMeta[] }
 *     chapters/<chapterId>.md               章节正文（Markdown）
 *     characters/<charId>.json              角色卡（rawData 无损保留）
 *     characters/<charId>.png               原始头像（可选）
 *     exports/                              导出的 md/txt/json
 *
 * 章节正文独立成文件：agent 可用自带的 read/write 工具直接读写长篇正文，
 * 顺序/标题/标签等元数据集中在 index.json，避免改名带来的文件churn。
 */
import type { CardSpec, Preset } from "../../src/types";

export interface NovelProject {
  /** 目录名，也是工具里引用的 projectId */
  id: string;
  title: string;
  synopsis: string;
  worldbuilding: string;
  authorNote: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChapterMeta {
  id: string;
  title: string;
  tags: string[];
  sortOrder: number;
  updatedAt: number;
}

/** 章节元数据 + 正文（列目录时从文件读取，避免与直接改文件的 agent 失同步） */
export interface Chapter extends ChapterMeta {
  content: string;
  words: number;
}

export interface StoredCharacter {
  id: string;
  name: string;
  specVersion: CardSpec;
  /** 项目目录内的头像文件名；无头像为 null */
  avatar: string | null;
  /** 导入时的原始 JSON，无损保留（再导出 PNG 时使用） */
  rawData: string;
  description: string;
  personality: string;
  scenario: string;
  firstMes: string;
  mesExample: string;
  creatorNotes: string;
  creator: string;
  lorebookCount: number;
  /** 是否参与写作（设定注入上下文） */
  active: boolean;
  createdAt: number;
}

export interface PresetFile {
  activePresetId: string | null;
  presets: Preset[];
}

export interface WorkspaceFile {
  version: number;
  activeProject: string | null;
}

export interface ChapterIndex {
  items: ChapterMeta[];
}

export const WORKSPACE_VERSION = 1;
