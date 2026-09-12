/**
 * Node API 的最小类型声明。
 *
 * 仓库根没有 @types/node（浏览器应用不需要），插件只用到极少几个 Node 能力，
 * 因此这里给出精确到用法的声明，配合 tsconfig 的 `types: []` 让插件独立通过严格检查。
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

declare module "node:path" {
  export function dirname(path: string): string;
  export function join(...parts: string[]): string;
}

declare module "node:url" {
  export function pathToFileURL(path: string): { href: string };
  export function fileURLToPath(url: string | URL): string;
}

declare module "node:module" {
  export function createRequire(anchor: string): {
    resolve(specifier: string): string;
  };
}

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd(): string;
};

declare const Buffer: {
  byteLength(input: string, encoding?: string): number;
};
