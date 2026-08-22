export interface Project {
  id?: number;
  title: string;
  /** 作品简介，用于展示 */
  synopsis: string;
  /** 世界观与背景设定，注入 AI prompt */
  worldbuilding: string;
  /** 作者备注，注入 AI prompt 的写作要求 */
  authorNote: string;
  /** 世界观 lorebook 条目，注入 AI prompt */
  lorebook: LoreEntry[];
  createdAt: number;
  updatedAt: number;
}

/** 世界观/设定词条（lorebook entry） */
export interface LoreEntry {
  id: string;
  name: string;
  /** 触发关键词，逗号分隔 */
  keys: string;
  content: string;
  enabled: boolean;
}

export interface Chapter {
  id?: number;
  projectId: number;
  title: string;
  content: string;
  sortOrder: number;
  updatedAt: number;
  /** 章节标签（如"伏笔"、"高潮"、"待修"），用于筛选与鸟瞰 */
  tags: string[];
}

export type CardSpec = "v1" | "v2" | "v3";

export interface Character {
  id?: number;
  projectId: number;
  name: string;
  avatar: Blob | null;
  avatarType: string;
  specVersion: CardSpec;
  /** 导入时的原始 JSON 字符串，无损保留，便于将来再导出 */
  rawData: string;
  description: string;
  personality: string;
  scenario: string;
  firstMes: string;
  mesExample: string;
  creatorNotes: string;
  creator: string;
  lorebookCount: number;
  /** 是否参与 AI 写作（其设定会被注入 prompt） */
  active: boolean;
  createdAt: number;
}

/** 持久化的聊天消息（userText 记录发送时的原始指令，供重新生成与续写重建上下文用） */
export interface ChatMessageStored {
  id: string;
  role: "user" | "assistant";
  content: string;
  userText?: string;
}

/** 每个项目一份聊天会话 */
export interface ChatSession {
  projectId: number;
  messages: ChatMessageStored[];
}

/** 写作预设：控制 AI 系统提示词，可导入 SillyTavern 预设 JSON */
export interface Preset {
  id: string;
  name: string;
  /**
   * 系统提示词模板。支持 {{char}}（首个参与写作的角色名）与
   * {{user}}（主角，默认“主角”）宏；留空则使用内置默认提示词。
   */
  systemPrompt: string;
  /**
   * SillyTavern context 模板的 story_string；留空则用内置默认设定区块。
   * 支持 {{#if 变量}}…{{/if}} 条件块，变量见 prompt.ts buildStoryVars。
   */
  storyString: string;
  /** SillyTavern 预设类型：system 提示词 / context 上下文模板 / instruct 对话格式 */
  kind: "system" | "context" | "instruct";
  /** 原始 JSON，无损保留 */
  rawData?: string;
  createdAt: number;
}

/**
 * 快速指令模板：聊天面板输入框上方的一键指令。
 * content 支持 {{selection}} 宏——发送时替换为编辑器当前选中文本；
 * 无选区时模板若含该宏则不自动发送，仅填入输入框由用户补充内容。
 */
export interface InstructionTemplate {
  id: string;
  name: string;
  content: string;
}

export const defaultInstructionTemplates: InstructionTemplate[] = [
  {
    id: "builtin-polish",
    name: "润色",
    content:
      "请润色以下段落：保持原意、人称与叙事节奏不变，优化遣词造句，让文字更凝练有画面感，直接输出润色后的正文，不要附加解释：\n\n{{selection}}",
  },
  {
    id: "builtin-expand",
    name: "扩写",
    content:
      "请扩写以下片段：补充环境氛围、人物动作与心理细节，保持原有风格与情节走向不变，篇幅扩至原来的两到三倍，直接输出扩写后的正文：\n\n{{selection}}",
  },
  {
    id: "builtin-summarize",
    name: "总结",
    content:
      "请概括以下内容的剧情要点（人物、事件、关键转折），输出简明大纲，便于后续章节保持连贯：\n\n{{selection}}",
  },
];

export type ProviderType = "openai" | "anthropic";

export interface AIProvider {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  models: string[];
}

export interface AppSettings {
  id?: number;
  providers: AIProvider[];
  activeProviderId: string | null;
  /** 续写时最多携带多少字的正文作为上下文 */
  contextChars: number;
  /** 续写时携带当前章节之前的章节数（0 = 不携带前文） */
  prevChapterCount: number;
  /** 每个前文章节最多携带的尾部字数 */
  prevChapterChars: number;
  /** 组装 API 请求时最多携带的对话轮数（0 = 全部携带） */
  chatContextTurns: number;
  temperature: number;
  maxTokens: number;
  presets: Preset[];
  /** 当前激活的写作预设；null 表示使用内置默认提示词 */
  activePresetId: string | null;
  /** 聊天面板快速指令模板 */
  instructionTemplates: InstructionTemplate[];
  /** 自动续写：每轮完成后等待多少毫秒再触发下一轮续写 */
  autoContinueIntervalMs: number;
  /** 主密码 hash（null = 未设锁，apiKey 明文存储） */
  masterHash: string | null;
  /** 主密码派生用的 salt（与 masterHash 同步设置） */
  masterSalt: string | null;
}

export const defaultSettings: AppSettings = {
  providers: [],
  activeProviderId: null,
  contextChars: 3000,
  prevChapterCount: 1,
  prevChapterChars: 1500,
  chatContextTurns: 10,
  temperature: 0.85,
  maxTokens: 1000,
  presets: [],
  activePresetId: null,
  instructionTemplates: defaultInstructionTemplates,
  autoContinueIntervalMs: 5000,
  masterHash: null,
  masterSalt: null,
};
