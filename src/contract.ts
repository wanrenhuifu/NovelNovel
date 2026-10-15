/**
 * DSH 插件 API 的最小契约（手写副本，仅类型，不含运行时实现）。
 *
 * 依据真实签名整理（@deepseek-ai/dsh 0.2.0-rc.2 / DSH Desktop）：
 *   - packages/core/tools/src/{index,schema,types}.ts → ToolDefinition / defineTool / ToolRunContext
 *   - packages/fs/fs/src/{index,types}.ts             → ctx.fs（FsVersion / FsTarget / FsObservation）
 *   - packages/core/agent/src/runtime-types.ts        → Agent（含 `.session`）
 *   - packages/core/session/src/types.ts              → Session / SessionHeader
 *   - packages/skill/skill/src/index.ts               → ctx.skills.register（runtime rank 250）
 *   - packages/interaction/commands/src/index.ts      → ctx.commands.register
 *   - packages/core/system-prompt/src/index.ts        → ctx.systemPrompt.section
 *   - packages/cordis（@deepseek-ai/cordis）           → Context
 *
 * 运行时的 defineTool 只有一份真品，由 harness.ts 解析（见该文件注释）；
 * 这里提供编译期类型，让插件源码不依赖 harness 的包解析路径。
 * 「未使用」标注的成员是为对齐真实签名保留的对照项——加进来是为了让下一次上游变更
 * 能被 `npm run typecheck` 之外的逐项比对发现，而不是靠记得去翻源码。
 */

/** 模型可见的内容块（工具只产出文本） */
export interface TextBlock {
  type: "text";
  text: string;
}
export type ContentBlock = TextBlock;


export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * 参数/输出 schema 的 DSL 子集（与 harness 的 ValueSchemaSpec 同构）：
 * `required` 只允许 true，显式 object 节点必须写 additionalProperties。
 */
export interface SchemaNode {
  type?: "string" | "number" | "integer" | "boolean" | "null" | "array" | "object" | "json";
  description?: string;
  title?: string;
  default?: JsonValue;
  examples?: JsonValue;
  enum?: readonly (string | number | boolean | null)[];
  const?: string | number | boolean | null;
  items?: SchemaNode;
  properties?: Record<string, SchemaNode>;
  additionalProperties?: boolean;
  required?: true;
  oneOf?: readonly SchemaNode[];
}
export type Parameters = Record<string, SchemaNode>;

/** 由 schema 推导出值类型（供 execute 返回值与 render 使用） */
export type InferValue<S> = S extends { oneOf: readonly (infer B)[] }
  ? InferValue<B>
  : S extends { type: "array"; items?: infer I }
    ? (I extends SchemaNode ? InferValue<I> : JsonValue)[]
    : S extends { type: "object"; properties?: infer P }
      ? InferObject<P>
      : S extends { enum: readonly (infer E)[] }
        ? E
        : S extends { type: "integer" | "number" }
          ? number
          : S extends { type: "string" }
            ? string
            : S extends { type: "boolean" }
              ? boolean
              : S extends { type: "null" }
                ? null
                : JsonValue;

type InferObject<P> = P extends Record<string, SchemaNode>
  ? {
      [K in keyof P as P[K] extends { required: true } ? K : never]: InferValue<P[K]>;
    } & {
      [K in keyof P as P[K] extends { required: true } ? never : K]?: InferValue<P[K]>;
    }
  : never;

/** 参数根是隐式 object：由 parameters 声明推导 execute 的 args 类型 */
export type InferArgs<S extends Parameters> = InferObject<S>;

/**
 * 会话身份：本插件只读 `header.cwd`（相对路径解析基准，也是与首方 dsh-tool-fs 同口径的取法）。
 * 真品另有 id/createdAt 等字段，用不到就不复制——契约副本复制得越多，上游加字段时越容易漏。
 * 因此这里每个成员都可选：真实的 Session 结构上满足它，测试里的最小桩也满足。
 */
export interface SessionHeader {
  readonly id?: string;
  readonly createdAt?: number;
  /** 会话工作目录；相对路径的解析基准 */
  readonly cwd?: string;
}

export interface Session {
  readonly header: SessionHeader;
}

/** 调用方 agent。`session` 同时是文件系统观察策略识别 owner 的途径（它读 actor.agent.session） */
export interface Agent {
  readonly id: string;
  readonly session: Session;
}

/** 工具的调用上下文（exec 参数） */
export interface ToolRunContext {
  readonly callId: string;
  readonly name: string;
  readonly arguments: unknown;
  /** 调用方拥有的取消信号：所有异步 IO 都必须传递 */
  readonly signal: AbortSignal;
  readonly agent?: Agent;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly output: {
    readonly schema: SchemaNode;
    render(args: never, value: never): ContentBlock[];
  };
  readonly timeoutMs?: number;
  execute(args: never, exec: ToolRunContext): Promise<unknown>;
}

/**
 * 本插件的工具输出值形状（对应 TEXT_OUTPUT schema）：
 * `details` 走 `json` 类型——harness 会在运行时校验无损 JSON，
 * 类型上用 unknown 表达，避免每个分支的可选字段都被索引签名卡住。
 */
export interface ToolResultValue {
  action: string;
  summary: string;
  details?: unknown;
}

export interface DefineToolOptions<S extends Parameters, O extends SchemaNode> {
  name: string;
  description: string;
  parameters: S;
  output: {
    schema: O;
    render(args: InferArgs<S>, value: ToolResultValue): ContentBlock[];
  };
  /** 协作式超时预算（由 harness 的超时策略插件执行） */
  timeoutMs?: number;
  isConcurrencySafe?(args: InferArgs<S>): boolean;
  execute(args: InferArgs<S>, exec: ToolRunContext): Promise<ToolResultValue>;
}

/** 真品 defineTool 的类型（运行时实例由 harness.ts 加载） */
export type DefineTool = <const S extends Parameters, const O extends SchemaNode>(
  options: DefineToolOptions<S, O>,
) => ToolDefinition;

/** ctx.fs 目标与结果 */
export interface FsTarget {
  readonly targetKey: unknown;
  readonly displayPath: string;
}
/** 内容版本：写入意图与观察记录都用它做 CAS 基准 */
export type FsVersion = unknown;
export interface FsInfo {
  readonly type: "file" | "directory" | "other";
  readonly size?: number;
  readonly version: FsVersion;
}
export interface FsDirEntry {
  readonly name: string;
  readonly type: "file" | "directory" | "other";
  readonly target: FsTarget;
  /**
   * 真品会带（实测 dsh-fs-local：`{name, type, target, version, size}`），手写契约原先漏了。
   * 用来做字数缓存的新鲜度判据：**一次 listDir 就能拿到全目录的大小**，
   * 比逐文件 stat 便宜一个数量级。
   */
  readonly size?: number;
}
/** `fs/observed` 的载荷：确认存在（带版本）或确认不存在 */
export type FsObservation =
  | { readonly kind: "present"; readonly version: FsVersion }
  | { readonly kind: "absent" };
export type FsWriteIntent = { kind: "createIfAbsent" } | { kind: "replaceIfVersion"; version: FsVersion };
export interface FsWriteOutcome {
  readonly operation: "create" | "update";
  readonly version: FsVersion;
  readonly before: string | null;
  readonly after: string;
}
/** 沙箱执行策略：写入时透传给 ctx.fs，越界写入由 harness 拒绝 */
export interface SandboxExecutionPolicy {
  readonly mode?: string;
  readonly workspaceRoot?: string;
  readonly sessionId?: string;
}

export interface FileSystemService {
  /**
   * 后端是否会强制隔离（未提供 = 不隔离）。
   * 首方 dsh-tool-fs 用它判断「需要 ctx.sandboxPolicy」；本插件不做升级授权，
   * 只把会话策略透传给 writeText——见 fsx.ts 的说明。
   */
  readonly sandboxMode?: string;
  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>;
  processPath(target: FsTarget): string;
  /** 该目标对应的 file:// URL（未使用，契约对照） */
  fileUrl(target: FsTarget): string;
  /** child 是否落在 parent 之内（含相等）——用于把 node:fs 写入限制在工作区内 */
  contains(parent: FsTarget, child: FsTarget): boolean;
  stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>;
  /** 按主机路径 stat（未使用，契约对照） */
  lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsInfo | undefined>;
  readText(target: FsTarget, signal?: AbortSignal): Promise<string>;
  /** 流式读文本（未使用，契约对照） */
  streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>>;
  readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>;
  /** 读字节区间（未使用，契约对照） */
  readByteRange(
    target: FsTarget,
    range: { offset: number; length: number },
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
  listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]>;
  writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome>;
  /**
   * 定点编辑（未使用，契约对照）：要求先观察过该文件，否则报 FS_NOT_OBSERVED。
   * 本插件写整份文件，所以走 writeText + 自己构造写入意图。
   */
  editText(
    target: FsTarget,
    edit: { oldText: string; newText: string; replaceAll?: boolean },
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<{ version: FsVersion }>;
}

export interface ToolRegistry {
  register(definition: ToolDefinition): () => void;
}

/**
 * `ctx.subagents` 的最小契约（@deepseek-ai/dsh-subagent 0.2.0-rc.2）。
 *
 * 只抄本插件真的用到的那一支：**一次性前台委派**。
 * - `start(providerName, request)` → `{ id, result, dispose }`；`result` **从不 reject**，
 *   失败信息在 `{ stopReason, diagnostic }` 里（`${pkg}/lib/types/index.js:389`）。
 * - `request.parent` 必须是**活的 Agent 实例**（工具里的 `exec.agent`）。插件是宿主侧代码、
 *   不是 Agent，"谁是父"只能由调用方给。
 * - `outputSchema` 是**标准 JSON Schema**（object 根；`required` 是字符串数组），
 *   provider 会给子 agent 挂一个 `structured_output` 工具，结果从 `result.structured` 取
 *   （`dsh-subagent-in-process-driver/lib/index.js:36-108、231-252`）。
 * - `toolFilter` 走 `childCtx.tools.restrict()`：`allow` = 只留这些全局工具，
 *   `deny` = 去掉这些。**点名不存在的工具会直接抛错**，所以这里用 `allow: []`
 *   （不点名任何工具，天然跨组合安全），子 agent 自己的 `structured_output` 是
 *   **scope-local 注册**，不受全局 mask 影响。
 * 不在本契约里的是「持久后台 agent」——那东西不存在（见 docs/design/auto-writer.md 的进度说明）。
 */
export interface SubagentRunResult {
  readonly output?: readonly ContentBlock[];
  /** provider 支持且子 agent 调用了 `structured_output` 时才有 */
  readonly structured?: unknown;
  readonly stopReason?: string;
  readonly diagnostic?: string;
}

export interface SubagentRun {
  readonly id: string;
  /** 注意：**从不 reject**，判失败要看 stopReason / structured 是否存在 */
  readonly result: Promise<SubagentRunResult>;
  dispose(): Promise<void>;
}

export interface SubagentAgentOptions {
  readonly provider?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly maxTokens?: number;
}

export interface SubagentStartRequest {
  readonly label?: string;
  readonly prompt: readonly ContentBlock[];
  readonly parent: Agent;
  readonly signal?: AbortSignal;
  readonly agentOptions?: SubagentAgentOptions;
  /** 子 agent 的 persona：注册成它自己作用域里的 `deployment:persona-prefix` 段 */
  readonly persona?: string;
  readonly toolFilter?: { readonly allow?: readonly string[]; readonly deny?: readonly string[] };
  readonly maxDepth?: number;
  readonly outputSchema?: Record<string, unknown>;
}

export interface SubagentsService {
  /** provider 名（dsh-base 组合里是 `spawn` 与 `fork`）；不存在时抛错 */
  start(provider: string, request: SubagentStartRequest): Promise<SubagentRun>;
  /** 已注册的 provider 名 */
  list(): readonly string[];
}

/** 技能资源根：本插件只产出 `directory` 形态，其余是契约对照 */
export type SkillResourceBase =
  | { readonly kind: "directory"; readonly path: string }
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "opaque"; readonly description: string };

/** 运行时技能注册（rank 250：项目级技能仍可覆盖同名插件技能） */
export interface SkillRegistration {
  name: string;
  description: string;
  content: string;
  source: string;
  whenToUse?: string;
  resourceBase?: SkillResourceBase;
  invocation?: { modelInvocable: boolean; userInvocable: boolean };
}
export interface SkillRegistryLike {
  register(skill: SkillRegistration): () => void;
}

export type CommandResult =
  | { readonly kind: "success"; readonly text?: string }
  | { readonly kind: "error"; readonly text: string };
export interface CommandDefinition {
  name: string;
  description: string;
  input?: { hint: string; attachments?: boolean };
  /** 真品的 invocation 另带 commandId 与 attachments；本插件都用不到，只声明用到的成员 */
  handler(invocation: {
    rawInput: string;
    signal: AbortSignal;
    agent?: Agent;
  }): CommandResult | Promise<CommandResult>;
}
export interface CommandsService {
  register(definition: CommandDefinition): () => void;
}

export interface PromptSection {
  name: string;
  order: number;
  text: string | ((context: { scope?: unknown }) => string);
  /** 段内 `{{var}}` 是否走提示词变量替换（默认 true） */
  interpolate?: boolean;
  /** 该段是否为「完整提示词」——置 true 时其余段被丢弃 */
  complete?: boolean;
}
export interface SystemPromptService {
  section(section: PromptSection): () => void;
}

export interface PluginLogger {
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
  error(message: string): void;
}

/** 插件拿到的 Cordis 上下文（只声明本插件用到的成员） */
export interface Context {
  readonly tools: ToolRegistry;
  readonly fs: FileSystemService;
  /** 软挂载：ctx.inject(['skills'], …) 之后才保证可用 */
  readonly skills: SkillRegistryLike;
  readonly commands: CommandsService;
  readonly systemPrompt: SystemPromptService;
  /**
   * 软挂载（`ctx.inject(['subagents'], …)`）：不是每个组合都有它
   * （headless/sdk 这类只有内核的 profile 就没挂）。缺了要**明说**，不能静默降级成"检查通过"。
   */
  readonly subagents: SubagentsService;
  readonly logger: PluginLogger;
  get<T = unknown>(name: string): T | undefined;
  inject(deps: string[], callback: (ctx: Context) => void): unknown;
  emit(event: string, ...args: unknown[]): void;
  waterfall<T>(event: string, ...args: unknown[]): T;
}

export interface SandboxPolicyService {
  /** 会话的沙箱策略；缺省 request 时给出部署默认（无会话调用走这一支） */
  resolve(request?: { session?: Session }): SandboxExecutionPolicy;
}

/**
 * `ctx.connection.fetch.register` 的一条路由（path 必须 `/api/<段>`，精确匹配）。
 *
 * 三处按真品抄写，别放宽：
 * - `methods` 是**大写**的联合类型。写成 `string[]` 的话 `["get"]` 能过 tsc，
 *   但 connection 用大写精确匹配（`route.methods.has(request.method)`），
 *   路由会永远 404，且 `requestBody` 退化成默认值——这种错没有任何报错。
 * - `fetch` 必须返回 Promise（真品签名如此）。
 * - `register` 返回的 disposer 在真品里是 `() => Promise<void>`。
 */
export type ConnectionFetchMethod = "GET" | "HEAD" | "POST";

export interface FetchRoute {
  path: string;
  methods: readonly ConnectionFetchMethod[];
  requestBody: "buffered" | "streaming";
  fetch: (request: Request) => Promise<Response>;
}

export interface ConnectionService {
  readonly fetch: {
    register(route: FetchRoute): () => Promise<void>;
  };
}
