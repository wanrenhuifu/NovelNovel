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
 *
 * 每个候选都要**自证身份**（见 assertRuntimeCopy）：开发工作树里躺着一份旧
 * `@deepseek-ai/*` 时，第 1、3 步会静默命中它，插件就变成加载第二份 harness 实例
 * ——服务重复注册、类型与运行时不一致，且症状出现在别处。宁可在这里报错。
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 候选解析锚点：越靠前越可能命中与运行中 harness 一致的安装 */
function resolutionAnchors(): string[] {
  const anchors: string[] = [];
  const entry = process.argv[1];
  if (entry) anchors.push(entry);
  // 显式锚点：桌面端/测试用它可以指明 harness 安装（profile 的 junction 坏掉时的唯一出路）
  const explicit = process.env.DSH_ENTRY;
  if (explicit) anchors.push(explicit, join(explicit, "anchor.mjs"));
  const dshHome = process.env.DSH_HOME;
  if (dshHome) anchors.push(join(dshHome, "profiles", "anchor.mjs"));
  anchors.push(join(process.cwd(), "anchor.mjs"));
  return anchors;
}

/**
 * 可信锚点：**不含 cwd**。
 *
 * 与 `resolutionAnchors()` 的差别就在这条：解析候选可以包含 cwd（profile 级模块后备目录在那），
 * 但**版本基准不能**——工作树里躺着旧 `@deepseek-ai` 副本时，cwd 会把旧版本变成基准并缓存进
 * `state.runtime`，此后每个候选都拿这个错基准去比，守卫等于白设。
 */
function trustedAnchors(): string[] {
  const anchors: string[] = [fileURLToPath(new URL("anchor.mjs", import.meta.url))];
  const entry = process.argv[1];
  if (entry) anchors.push(entry);
  const explicit = process.env.DSH_ENTRY;
  if (explicit) anchors.push(explicit, join(explicit, "anchor.mjs"));
  const dshHome = process.env.DSH_HOME;
  if (dshHome) anchors.push(join(dshHome, "profiles", "anchor.mjs"));
  return anchors;
}

/**
 * 读一个包的版本。走 createRequire 而不是 node:fs：本包在 `types: []` 下编译，
 * 没有 node 类型声明，`node:fs` 用不了；模块解析器则本来就可用。
 * `resolvedPath` 是已解析出的模块文件，manifest 就在它所属包的目录里。
 */
function packageVersion(from: string, name: string, resolvedPath?: string): string | undefined {
  // 两条路都试：`require.resolve` 是解析器给出的真实包根，而手工 `..` 在入口是
  // 嵌套形态（`dist/esm/*.mjs`、exports 指到子目录）时会指到一个无关目录里的 package.json，
  // 读出来的就是**别的包**的版本。
  const candidates: string[] = [];
  try {
    candidates.push(createRequire(from).resolve(`${name}/package.json`));
  } catch {
    /* 下一步用手工路径兜底 */
  }
  if (resolvedPath !== undefined) candidates.push(join(dirname(resolvedPath), "..", "package.json"));
  for (const manifestPath of candidates) {
    try {
      const manifest = createRequire(from)(manifestPath) as { version?: unknown };
      if (typeof manifest.version === "string") return manifest.version;
    } catch {
      /* 换下一个候选 */
    }
  }
  return undefined;
}

/**
 * 运行时版本 = harness 安装里 `@deepseek-ai/dsh-app-boot` 的版本。
 * 同一安装内的 `@deepseek-ai/dsh-*` 子包同版本发布，插件清单的 peer 就是按它判定的。
 *
 * 基准只从 `trustedAnchors()` 取（**有意不含 cwd**，理由见那个函数）。
 * 全部落空返回 undefined（调用方据此报错，而不是放行）。
 */
function runtimeVersion(): string | undefined {
  const state = versionBaseline();
  if (state.runtime !== undefined) return state.runtime;
  for (const anchor of trustedAnchors()) {
    const version = packageVersion(anchor, "@deepseek-ai/dsh-app-boot");
    if (version !== undefined) {
      state.runtime = version;
      return version;
    }
  }
  return undefined;
}

interface Semver {
  major: number;
  minor: number;
  patch: number;
  pre: readonly (string | number)[];
}

/** 只解析 SemVer 主版本段；build metadata 忽略，非法返回 undefined */
function parseSemver(value: string): Semver | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  if (!match) return undefined;
  const pre = (match[4]?.split(".") ?? []).map((part) =>
    /^\d+$/.test(part) ? Number(part) : part,
  );
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre };
}

/** 按 SemVer §11 比较 prerelease：数字段 < 字母段，短的一方更小；无 prerelease 的更大 */
function comparePrerelease(left: readonly (string | number)[], right: readonly (string | number)[]): number {
  for (let index = 0; ; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined && b === undefined) return 0;
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNumeric = typeof a === "number";
    if (aNumeric !== (typeof b === "number")) return aNumeric ? -1 : 1;
    return a < b ? -1 : 1;
  }
}

function sameVersion(left: Semver | undefined, right: Semver | undefined): boolean {
  if (!left || !right) return false;
  return (
    left.major === right.major &&
    left.minor === right.minor &&
    left.patch === right.patch &&
    comparePrerelease(left.pre, right.pre) === 0
  );
}

/**
 * 判断版本是否落在清单 peer 区间内。只支持本仓库会写的区间形态
 * （`*` / 精确 / `^` / `~` / 比较符 / `||`），并**严格**对待 prerelease：
 * 带 prerelease 的版本只与「同一 major.minor.patch 且自身带 prerelease」的区间匹配
 * （与 semver 默认语义一致，跳过它等于把升级风险留到运行期）。
 * 不认识的区间返回 undefined，由调用方退回运行时版本相等的判定。
 */
function satisfies(range: string, version: string): boolean | undefined {
  const parsed = parseSemver(version);
  if (!parsed) return undefined;
  const alternatives = range.split("||").map((part) => part.trim());
  if (alternatives.some((alternative) => alternative === "")) return undefined;
  let known = true;
  const matched = alternatives.some((alternative) => {
    if (alternative === "*" || alternative === "latest") return true;
    const comparators = alternative.split(/\s+/);
    return comparators.every((comparator) => {
      const match = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(comparator);
      if (!match) {
        known = false;
        return false;
      }
      const bound = parseSemver(match[2]);
      if (!bound) {
        known = false;
        return false;
      }
      // prerelease 只与自带 prerelease 的同 major.minor.patch 区间匹配
      if (
        parsed.pre.length > 0 &&
        bound.pre.length === 0 &&
        (parsed.major !== bound.major || parsed.minor !== bound.minor || parsed.patch !== bound.patch)
      ) {
        return false;
      }
      const order = ((): number => {
        if (parsed.major !== bound.major) return parsed.major < bound.major ? -1 : 1;
        if (parsed.minor !== bound.minor) return parsed.minor < bound.minor ? -1 : 1;
        if (parsed.patch !== bound.patch) return parsed.patch < bound.patch ? -1 : 1;
        return comparePrerelease(parsed.pre, bound.pre);
      })();
      switch (match[1]) {
        case undefined:
        case "=":
          return order === 0;
        case ">":
          return order > 0;
        case ">=":
          return order >= 0;
        case "<":
          return order < 0;
        case "<=":
          return order <= 0;
        case "^":
          return order >= 0 && parsed.major === bound.major;
        case "~":
          return order >= 0 && parsed.major === bound.major && parsed.minor === bound.minor;
        default:
          known = false;
          return false;
      }
    });
  });
  return known ? matched : undefined;
}

/** 本包清单声明的 peer 区间；读不到返回空表 */
function declaredPeers(): Record<string, string> {
  try {
    const require = createRequire(import.meta.url);
    const manifest = require("../package.json") as { peerDependencies?: unknown };
    const peers = manifest.peerDependencies;
    if (!peers || typeof peers !== "object") return {};
    return peers as Record<string, string>;
  } catch {
    return {};
  }
}

/** harness 包的版本基准：运行时版本，外加本包清单里 @deepseek-ai/dsh-* 的 peer 区间 */
let baseline: { runtime?: string; peers: Record<string, string> } | undefined;

function versionBaseline(): { runtime?: string; peers: Record<string, string> } {
  baseline ??= { peers: declaredPeers() };
  return baseline;
}

/**
 * 校验解析结果确实属于运行中的 harness。三种不通过都抛错：
 *   - 解析到的版本不满足本包清单声明的 peer 区间；
 *   - 区间判定不适用（清单写的是 `*` 这类）时，版本必须与运行时版本相等；
 *   - 连运行时版本都定不下来（锚点都不在 harness 安装里）——这时任何副本都无法自证身份，
 *     放行等于把「第二份 harness」留到最后才炸，所以也拒绝并附上修法。
 */
function assertRuntimeCopy(specifier: string, resolvedPath: string, anchor: string): void {
  const state = versionBaseline();
  const found = packageVersion(anchor, specifier, resolvedPath);
  const runtime = runtimeVersion();
  if (runtime === undefined) {
    throw new Error(
      `dsh-novelnovel: cannot determine the running harness version, so "${specifier}" at ${resolvedPath} ` +
        `cannot be proven to belong to it${found === undefined ? "" : ` (that copy is ${found})`}.\n` +
        "Point the plugin at the harness installation (DSH Desktop ships one; the CLI launcher does this for you):\n" +
        "  dsh plugin --profile <name> add <path|tarball>\n" +
        "Resolving from this working tree is not enough — a leftover @deepseek-ai copy there would be a second harness.",
    );
  }
  // 读不出这一份的版本 = **证明不了**它属于运行中的 harness。原来这里直接 return 放行，
  // 而 `packageVersion` 在入口是嵌套形态、或恰好指到一个无关的 package.json 时会返回
  // undefined —— 于是守卫在这条路径上完全空转。宁可报错：放行的代价是运行期加载第二份 harness。
  if (found === undefined) {
    throw new Error(
      `dsh-novelnovel: "${specifier}" resolved to ${resolvedPath} but its package.json could not be read, ` +
        "so this copy cannot be proven to belong to the running harness.\n" +
        "Point the plugin at the harness installation (DSH Desktop ships one; the CLI launcher does this for you):\n" +
        "  dsh plugin --profile <name> add <path|tarball>",
    );
  }
  const range = state.peers[specifier];
  const verdict =
    range === undefined ? undefined : range.trim() === "*" ? undefined : satisfies(range, found);
  if (verdict === true) return;
  if (verdict === undefined && sameVersion(parseSemver(found), parseSemver(runtime))) return;
  throw new Error(
    `dsh-novelnovel: "${specifier}" resolved to an incompatible copy at ${resolvedPath}\n` +
      `  resolved version: ${found}\n` +
      `  running harness:  ${runtime}\n` +
      (range === undefined ? "" : `  declared peer:    ${JSON.stringify(range)}\n`) +
      "Loading a second harness instance would register the same services twice. " +
      "Fix the installation so the profile — not this working tree — supplies the harness packages:\n" +
      "  dsh plugin --profile <name> add <path|tarball>\n" +
      "DSH Desktop owns the `desktop` profile: fully quit the application, then use its packaged CLI,\n" +
      "  <DSH install>\\resources\\runtime\\cli\\bin\\dsh.cmd plugin --profile desktop add <path>",
  );
}

/** 加载一个 harness 包；失败时抛出带排查提示的错误 */
export async function loadHarnessModule<T>(specifier: string): Promise<T> {
  const failures: string[] = [];
  let sawIncompatibleCopy = false;
  const attempts: string[] = [
    fileURLToPath(new URL("anchor.mjs", import.meta.url)),
    ...resolutionAnchors(),
  ];

  for (const anchor of attempts) {
    let resolved: string;
    try {
      resolved = createRequire(anchor).resolve(specifier);
    } catch (error: unknown) {
      failures.push(`${dirname(anchor)}: ${(error as Error).message}`);
      continue;
    }
    try {
      assertRuntimeCopy(specifier, resolved, anchor);
    } catch (error: unknown) {
      sawIncompatibleCopy = true;
      failures.push(`${dirname(anchor)}: ${(error as Error).message}`);
      continue;
    }
    // 解析与身份校验都过了：这里的失败是**模块自身的加载错误**（例如它 import 了别的东西），
    // 不能伪装成「找不到 harness 包」，否则真正的原因会被埋进兜底链的日志里。
    return (await import(pathToFileURL(resolved).href)) as T;
  }

  throw new Error(
    (sawIncompatibleCopy
      ? `dsh-novelnovel: no copy of "${specifier}" could be proven to belong to the running harness.\n`
      : `dsh-novelnovel: cannot resolve harness package "${specifier}".\n` +
        `Install the plugin with \`dsh plugin --profile <name> add <path|tarball>\` so the ` +
        `profile can reach the harness dependency closure.\n`) + `Tried:\n${failures.join("\n")}`,
  );
}
