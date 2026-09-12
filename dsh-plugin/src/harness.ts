/**
 * harness 模块加载：`@deepseek-ai/*` 是插件的 peer，运行时由 harness 自身提供，
 * 插件不得内联第二份（服务按模块实例注册，双份会重复注册）。
 *
 * 以 `link:` 方式安装时，Node 从本包 realpath 向上查找是找不到 harness 依赖闭包的
 * （profile 的 node_modules 在另一个目录树里）。因此按以下顺序解析，命中即用：
 *   1. 普通 import——插件被复制进 profile 的 node_modules 时直接可用；
 *   2. 从 harness 进程入口（process.argv[1]）所在安装解析——保证与运行中的 harness
 *      是同一个模块实例；
 *   3. 从 $DSH_HOME/profiles 与当前工作目录解析——harness 的 profile 级模块后备目录。
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** 包名不存在的错误（用于区分「该换个锚点再试」和真正的加载失败） */
function isResolutionFailure(error: unknown, specifier: string): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") return true;
  return error instanceof Error && error.message.includes(specifier) && code === undefined;
}

/** 候选解析锚点：越靠前越可能命中与运行中 harness 一致的安装 */
function resolutionAnchors(): string[] {
  const anchors: string[] = [];
  const entry = process.argv[1];
  if (entry) anchors.push(entry);
  const dshHome = process.env.DSH_HOME;
  if (dshHome) anchors.push(join(dshHome, "profiles", "anchor.mjs"));
  anchors.push(join(process.cwd(), "anchor.mjs"));
  return anchors;
}

/** 加载一个 harness 包；失败时抛出带排查提示的错误 */
export async function loadHarnessModule<T>(specifier: string): Promise<T> {
  try {
    return (await import(specifier)) as T;
  } catch (error: unknown) {
    if (!isResolutionFailure(error, specifier)) throw error;
  }

  const failures: string[] = [];
  for (const anchor of resolutionAnchors()) {
    try {
      const require = createRequire(anchor);
      const resolved = require.resolve(specifier);
      return (await import(pathToFileURL(resolved).href)) as T;
    } catch (error: unknown) {
      failures.push(`${dirname(anchor)}: ${(error as Error).message}`);
    }
  }

  throw new Error(
    `dsh-novelnovel: cannot resolve harness package "${specifier}".\n` +
      `Install the plugin with \`dsh plugin --profile <name> add <path|tarball>\` so the ` +
      `profile can reach the harness dependency closure.\nTried:\n${failures.join("\n")}`,
  );
}
