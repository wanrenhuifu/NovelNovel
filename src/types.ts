/**
 * 插件持久化结构：数据以「人可读、agent 可直改」的文件形式落在工作目录下。
 *
 * <工作目录>/<dataDir>/                     默认 .novelnovel
 *   workspace.json                          { version, activeProject }
 *   projects/<projectId>/
 *     project.json                          作品元数据（outline 可选）
 *     lorebook.json                         LoreEntry[]
 *     presets.json                          { activePresetId, presets }
 *     chapters/index.json                   { items: ChapterMeta[] }（goal / summary 可选）
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
  /**
   * 全书梗概（大纲第一层）。**可选**：老作品没有这个字段时一切照旧（简报里少一段大纲，其余逐字不变）。
   *
   * 写入通道是 `novel_project action=create/update`（`action=show` 回显）。**每章自动带上**：
   * 按 docs/design/auto-writer.md §4 它是 Push 层（「不可遗漏」），非空时进系统提示词的独立区块
   * `## 全书大纲`，且**无条件附带**——不吃预设 story_string 的整块替换。第一层只有 300–800 字，
   * 与第二层 `outline.md` 是两回事：那份细纲太长、不进简报，由模型用首方 read/write 工具按需读。
   */
  outline?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChapterMeta {
  id: string;
  title: string;
  tags: string[];
  sortOrder: number;
  /**
   * 这一章要推进什么（大纲第三层）。**可选**：缺失时简报与旧版逐字一致。
   *
   * 它进简报走的是**单独一条通路**（novel_context → buildContinueUserMessage 的指令块），
   * 而不是系统提示词——`buildSystemPrompt` 收不到章节元数据，搭不上那趟便车。
   */
  goal?: string;
  /**
   * 每章摘要。**可选**，且**不注入简报**：摘要是有损的，写第 N 章时用前几章摘要替换原文
   * 会悄悄丢掉细节（docs/design/auto-writer.md §3.1 明确否决了"摘要进简报"）。
   * 留给检索结果展示用。
   */
  summary?: string;
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
