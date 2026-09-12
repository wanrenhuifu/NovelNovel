/**
 * 插件侧的领域类型：角色卡字段、Lorebook 词条、写作预设。
 *
 * 只含解析与组装真正需要的字段：没有数值主键、没有 Blob 头像、没有表结构——
 * 落盘形式（一章一个 Markdown、一张卡一个 JSON）由 src/types.ts 与 NovelStore 决定。
 */

export type CardSpec = "v1" | "v2" | "v3";

/** SillyTavern 角色卡解析后的扁平字段 */
export interface CardFields {
  name: string;
  specVersion: CardSpec;
  /** 导入时的原始 JSON 字符串，无损保留，便于再导出 */
  rawData: string;
  description: string;
  personality: string;
  scenario: string;
  firstMes: string;
  mesExample: string;
  creatorNotes: string;
  creator: string;
  lorebookCount: number;
  /** 是否参与写作（其设定会被注入提示词） */
  active: boolean;
  createdAt: number;
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

/** 写作预设：控制系统提示词的组装方式，可导入 SillyTavern 预设 JSON */
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
