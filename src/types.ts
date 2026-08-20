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
  temperature: number;
  maxTokens: number;
  presets: Preset[];
  /** 当前激活的写作预设；null 表示使用内置默认提示词 */
  activePresetId: string | null;
}

export const defaultSettings: AppSettings = {
  providers: [],
  activeProviderId: null,
  contextChars: 3000,
  temperature: 0.85,
  maxTokens: 1000,
  presets: [],
  activePresetId: null,
};
