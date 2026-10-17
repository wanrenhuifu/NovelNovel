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
import type { Channel, DecomposedSource } from "./domain/sourceImport";

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
  /**
   * 全书目标字数（可选）。**只用于看目标与进度**：面板与 `action=show` / `novel_context`
   * 的进度行会显示「已写 3.6 万 / 目标 10 万」，它**不改变模型怎么写**——
   * 每章的字数要求仍然写在 `authorNote`（写作要求）或每章的 `goal` 里。
   *
   * 与其它可选字段同口径：没有这个键时一切照旧；传 0（或面板上清空）就是删掉它。
   */
  targetWords?: number;
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
   * 留给检索结果展示用。`novel_review` 通过后会把子 agent 写的摘要落到这里。
   */
  summary?: string;
  /**
   * 最近一次自检的结论（`novel_review` 写）。**可选**：没有它一切照旧。
   *
   * 存在这里的理由是「同一章连续判不合格几次」这个计数**必须落盘**：模型自己数记不住，
   * 数丢了就变成无限重写同一章（docs/design/auto-writer.md §2.2：停下来的条件是"正文写不出来"，
   * 所以重写要有次数上限）。顺带得到一个可审计的留痕：人能查「这一章当时被判过什么」。
   */
  review?: ChapterReview;
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

/**
 * 一次章节自检的结论（`ChapterMeta.review`）。
 *
 * 与 `summary` 的分工：`summary` 是**内容**（这章讲了什么，供检索），
 * 这个字段是**过程**（这章被判过什么、连败几次）。
 */
export interface ChapterReview {
  /** 连续判不合格的次数；判定通过时归零 */
  attempts: number;
  /**
   * 判定结论。`inconclusive` = 本地硬门槛过了，但**语义检查没跑或没给出结论**
   * （没有 subagents 服务 / 子 agent 报错 / 返回坏形状 / 只跑了 `local_only`）。
   * 它既不算通过也不算不合格：写 `pass` 是在数据文件里说谎，写 `fail` 会推动无意义的重写。
   */
  verdict: "pass" | "fail" | "inconclusive";
  /** 最后一次判定的时间 */
  at: number;
  /** 最近一次的问题清单（英文，子 agent 给的具体改法）；通过时为空 */
  issues?: string[];
  /**
   * 语义自检实际走到哪一步：
   * - `ok`：子 agent 真的判了；
   * - `local-only`：只跑了本地硬门槛（`local_only`，或本次没起子 agent）；
   * - `unavailable`：这个组合里没有 subagent 服务；
   * - `failed`：起了但没给出可用结论（服务报错、坏形状）。
   * 后两种**不计入 attempts**，也不清零——基础设施故障不等于"这一章写坏了"。
   */
  semantic: "ok" | "local-only" | "unavailable" | "failed";
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

/** 资料源的落盘记录（`sources/index.json` 的一项） */
export interface SourceRecord {
  id: string;
  /** card = 模块卡；lore-book = 独立世界书 */
  kind: "card" | "lore-book";
  name: string;
  enabled: boolean;
  /** 排序/覆盖优先级：文风叠加时按它排，设定同名冲突时高者覆盖 */
  priority: number;
  /** 原始文件路径（只记录，不复制原件——10 MB 的卡复制两份没必要） */
  originFile: string;
  originSize: number;
  createdAt: number;
  /** 导入时判出的通道计数，便于列表直接显示 */
  counts: Record<Channel, number>;
}

/** 一个资料源的全部内容（`sources/<id>.json`） */
export interface StoredSource {
  record: SourceRecord;
  payload: DecomposedSource;
}