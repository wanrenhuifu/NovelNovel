/**
 * DSH 插件 API 的最小契约（手写副本，仅类型，不含运行时实现）。
 *
 * 依据真实签名整理（@deepseek-ai/dsh 0.1.2-rc.1 / 0.1.3-alpha.2）：
 *   - packages/core/tools/src/{index,schema}.ts   → ToolDefinition / defineTool / ToolRunContext
 *   - packages/fs/fs/src/{index,types}.ts         → ctx.fs
 *   - packages/skill/skill/src/index.ts           → ctx.skills.register
 *   - packages/interaction/commands/src/index.ts  → ctx.commands.register
 *   - packages/core/system-prompt/src/index.ts    → ctx.systemPrompt.section
 *   - packages/cordis（@deepseek-ai/cordis）       → Context
 *
 * 运行时的 defineTool 只有一份真品，由 harness.ts 解析（见该文件注释）；
 * 这里提供编译期类型，让插件源码不依赖 harness 的包解析路径。
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

/** 工具的调用上下文（exec 参数） */
export interface ToolRunContext {
  readonly callId: string;
  readonly name: string;
  readonly arguments: unknown;
  /** 调用方拥有的取消信号：所有异步 IO 都必须传递 */
  readonly signal: AbortSignal;
  readonly agent?: {
    readonly id: string;
    readonly session: { readonly header: { readonly cwd?: string } };
  };
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
export interface FsInfo {
  readonly type: "file" | "directory" | "other";
  readonly size?: number;
  readonly version: unknown;
}
export interface FsDirEntry {
  readonly name: string;
  readonly type: "file" | "directory" | "other";
  readonly target: FsTarget;
}
export type FsWriteIntent = { kind: "createIfAbsent" } | { kind: "replaceIfVersion"; version: unknown };
export interface FsWriteOutcome {
  readonly operation: "create" | "update";
  readonly version: unknown;
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
  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>;
  processPath(target: FsTarget): string;
  /** child 是否落在 parent 之内（含相等）——用于把 node:fs 写入限制在工作区内 */
  contains(parent: FsTarget, child: FsTarget): boolean;
  stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>;
  readText(target: FsTarget, signal?: AbortSignal): Promise<string>;
  readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>;
  listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]>;
  writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome>;
}

export interface ToolRegistry {
  register(definition: ToolDefinition): () => void;
}

/** 运行时技能注册（rank 250：项目级技能仍可覆盖同名插件技能） */
export interface SkillRegistration {
  name: string;
  description: string;
  content: string;
  source: string;
  whenToUse?: string;
  resourceBase?: { kind: "directory"; path: string };
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
  handler(invocation: {
    rawInput: string;
    signal: AbortSignal;
    agent?: { readonly session: { readonly header: { readonly cwd?: string } } };
  }): CommandResult | Promise<CommandResult>;
}
export interface CommandsService {
  register(definition: CommandDefinition): () => void;
}

export interface PromptSection {
  name: string;
  order: number;
  text: string | ((context: { scope?: unknown }) => string);
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
  readonly logger: PluginLogger;
  get<T = unknown>(name: string): T | undefined;
  inject(deps: string[], callback: (ctx: Context) => void): unknown;
  emit(event: string, ...args: unknown[]): void;
  waterfall<T>(event: string, ...args: unknown[]): T;
}

export interface SandboxPolicyService {
  resolve(request?: { session?: unknown }): SandboxExecutionPolicy;
}
