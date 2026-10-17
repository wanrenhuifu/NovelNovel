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
  /** 卡内世界书的**原始**条目数（不是并入项目 lorebook 的数量，那个由导入结果给出） */
  lorebookEntriesInCard: number;
  /** 是否参与写作（其设定会被注入提示词） */
  active: boolean;
  createdAt: number;
}

/** 世界观/设定词条（lorebook entry） */
/**
 * 注入通道。决定"这条东西怎么进上下文"——ST 的世界书只有"关键词/常驻"两档，没有通道概念，
 * 所以文风、玩法规则、世界设会混在一个池子里按运气命中。
 */
export type Channel =
  /** 设定：关键词命中才注入（地理/组织/历史/秘境） */
  | "lore"
  /** 文风：常驻进写作要求区；多源可叠加 */
  | "style"
  /** 玩法：规则/生成器/判定表，常驻进规则区，不按关键词抽 */
  | "gameplay"
  /** 状态：初值树/变量索引，不进世界书，交给状态层 */
  | "state"
  /** 角色：人物档案，按名字关键词命中 */
  | "cast"
  /** 素材：开篇剧本、状态栏模板、UI 脚本——不注入，只读展示 */
  | "material";

export interface LoreEntry {
  id: string;
  name: string;
  /** 触发关键词，逗号分隔 */
  keys: string;
  content: string;
  enabled: boolean;
  /** 来自哪个资料源（可选：手写条目没有来源） */
  source?: string;
  /** 注入通道（可选：缺省按 keys 是否为空推断，老数据不用迁移） */
  channel?: Channel;
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
