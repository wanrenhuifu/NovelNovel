/**
 * Node API 的最小类型声明。
 *
 * 本包不依赖 @types/node：插件只用到极少几个 Node 能力，因此这里给出精确到用法的声明，
 * 配合 tsconfig 的 `types: []` 让插件独立通过严格检查（运行时行为由 Node 提供）。
 * 真实运行时的 API 行为由 Node 提供。
 */
declare module "node:fs/promises" {
  export function mkdir(
    path: string,
    options?: { recursive?: boolean },
  ): Promise<string | undefined>;
  export function rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<void>;
  export function writeFile(path: string, data: Uint8Array): Promise<void>;
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function readdir(path: string): Promise<string[]>;
}

declare module "node:fs" {
  /**
   * `realpathSync.native`：把符号链接/junction 解析成真实路径。
   * 只用于 `assertInsideWorkspace` 的第二道判定——`ctx.fs.contains` 是纯字符串比较，
   * 工作区内的链接会骗过它，而 node:fs 的读写是跟随链接的。
   */
  export const realpathSync: { native(path: string): string };
}

declare module "node:path" {
  export function dirname(path: string): string;
  export function join(...parts: string[]): string;
  export function isAbsolute(path: string): boolean;
  /** 第二个参数相对第一个参数的路径（同盘符时才是相对形式） */
  export function relative(from: string, to: string): string;
}

declare module "node:url" {
  export function pathToFileURL(path: string): { href: string };
  export function fileURLToPath(url: string | URL): string;
}

declare module "node:module" {
  /** `require` 的最小形态：解析裸说明符，或直接读一个文件的导出（如 package.json） */
  export interface MinimalRequire {
    resolve(specifier: string): string;
    (specifier: string): unknown;
  }
  export function createRequire(anchor: string): MinimalRequire;
}

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd(): string;
};

declare const Buffer: {
  byteLength(input: string, encoding?: string): number;
};
