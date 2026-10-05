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
import type { CardFields, Preset } from "./domain/types";

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
  /**
   * 字数缓存 + 它对应的正文**字节数**。
   *
   * 只给「列目录/看总字数」用，**不是权威值**：读的时候会 `stat` 一次比对 `size`，
   * 不一致就重读正文重算——所以直接改文件也不会显示旧字数（README 承诺过这条）。
   * 两者都缺失时视为"没有缓存"，同样走重读。
   */
  wordsCache?: { words: number; size: number };
}

/** 章节元数据 + 正文（列目录时从文件读取，避免与直接改文件的 agent 失同步） */
export interface Chapter extends ChapterMeta {
  content: string;
  words: number;
}

/** 落盘的角色卡：卡片字段（与领域层同一形状）+ 存储用的 id 与头像文件名 */
export interface StoredCharacter extends CardFields {
  id: string;
  /** 项目目录内的头像文件名（扩展名与真实媒体类型一致）；无头像为 null */
  avatar: string | null;
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
