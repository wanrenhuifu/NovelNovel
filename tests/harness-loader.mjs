/**
 * 测试用的 harness 加载器：把 `@deepseek-ai/*` 固定解析到**正在运行的那份**
 * DSH 安装，而不是仓库根可能残留的旧副本。
 *
 * 为什么必须有它：以 `link:` 装插件时，Node 从仓库位置向上找 `@deepseek-ai/*`
 * 会先命中 `node_modules/` 里可能存在的旧版本——那会让测试进程里出现第二份
 * harness（服务按模块实例注册，双份会重复注册），而且与 `src/harness.ts`
 * 在真实运行时的解析结果不一致。所以这里和运行时同口径：只认 harness 安装。
 *
 * 锚点顺序：
 *   1. $DSH_ENTRY                     —— 显式指定的 harness 入口或安装目录
 *   2. $DSH_HOME/profiles/node_modules —— harness 的 profile 级模块后备目录
 *   3. <DSH 安装>/resources/app.asar/dsh/node_modules —— 桌面端自带安装（DSH_INSTALL 覆盖，默认 D:\DSH）
 * 全部落空就报错退出（不静默回落到 cwd），并在信息里写清怎么修。
 *
 * `registerHarnessHook()` 复制桌面端 profile 解析器的行为：凡是从本仓库（linked root）
 * 里发出的 `@deepseek-ai/*` 裸请求，一律改派到 harness 安装——这样插件产物
 * `lib/index.js` 的顶层 import 与 `src/harness.ts` 的运行时解析拿到的是同一份实例。
 */
import { realpathSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const PROBE = "@deepseek-ai/dsh-app-boot/package.json";

/** 候选锚点文件（createRequire 的基准），越靠前越优先 */
function candidateAnchors() {
  const anchors = [];
  const entry = process.env.DSH_ENTRY;
  if (entry) anchors.push(entry, join(entry, "package.json"), join(entry, "anchor.mjs"));
  const dshHome = process.env.DSH_HOME;
  if (dshHome) anchors.push(join(dshHome, "profiles", "anchor.mjs"));
  // 桌面端：从本仓库位置推不出来，所以按约定位置探测；DSH_INSTALL 可覆盖
  for (const install of [process.env.DSH_INSTALL, "D:\\DSH"].filter(Boolean)) {
    anchors.push(join(install, "resources", "app.asar", "dsh", "node_modules", "anchor.mjs"));
    anchors.push(join(install, "resources", "app", "node_modules", "anchor.mjs"));
  }
  return anchors;
}

let anchor;

/** 解析到 harness 安装的锚点文件；解析不到直接抛错（不回落） */
export function harnessAnchor() {
  if (anchor) return anchor;
  const tried = [];
  for (const candidate of candidateAnchors()) {
    // 不能先 existsSync：asar 内的路径在 Node 的 fs 里根本不存在，
    // 但只要进程带上了 Electron 的 asar 支持（桌面端就是这样跑的）就能解析。
    try {
      createRequire(candidate).resolve(PROBE);
      anchor = candidate;
      return anchor;
    } catch (error) {
      tried.push(`${candidate}: ${error.code ?? error.message}`);
    }
  }
  throw new Error(
    [
      `找不到运行中的 DSH 安装（探测 ${PROBE} 失败）。`,
      "测试不能在仓库根解析 @deepseek-ai/*——那里可能残留旧 harness 副本，",
      "会让测试进程加载第二份服务实例。修法（任选其一）：",
      '  $env:DSH_INSTALL = "<DSH 安装目录>"    # 默认探测 D:\\DSH',
      '  $env:DSH_ENTRY = "<锚点文件>"          # 例如 <安装>\\resources\\app.asar\\dsh\\node_modules\\anchor.mjs',
      "  # 或修好 $DSH_HOME/profiles/node_modules 里指向安装目录的 junction",
      "已尝试：",
      ...tried.map((line) => `  ${line}`),
    ].join("\n"),
  );
}

let profileAnchor;

/** 插件自身的解析锚点：active profile 目录（`dsh-novelnovel` 装在那里），退回 cwd */
function installAnchor() {
  if (profileAnchor) return profileAnchor;
  const candidates = [];
  const dshHome = process.env.DSH_HOME;
  const profile = process.env.DSH_PROFILE;
  if (dshHome && profile) candidates.push(join(dshHome, "profiles", profile, "package.json"));
  if (dshHome) candidates.push(join(dshHome, "profiles", "anchor.mjs"));
  candidates.push(join(process.cwd(), "anchor.mjs"));
  for (const candidate of candidates) {
    try {
      createRequire(candidate).resolve("dsh-novelnovel/package.json");
      profileAnchor = candidate;
      return profileAnchor;
    } catch {
      // 下一个锚点
    }
  }
  throw new Error(
    [
      "解析不到插件包 dsh-novelnovel。",
      `确认它已装进当前 profile（DSH_PROFILE=${process.env.DSH_PROFILE ?? "(未设置)"}，DSH_HOME=${dshHome ?? "(未设置)"}）：`,
      "  <DSH 安装>\\resources\\runtime\\cli\\bin\\dsh.cmd plugin --profile <name> add <本仓库路径>",
    ].join("\n"),
  );
}

/** 与 src/harness.ts 同口径的加载：harness 包走 harness 安装，插件包走 profile */
export async function load(specifier) {
  return import(pathToFileURL(resolveFrom(specifier)).href);
}

/** 解析为绝对路径（需要读 package.json 之类的场景） */
export function resolveFrom(specifier) {
  // @deepseek-ai/* 必须来自 harness 安装（app.asar）；其余（插件本体、@lenml/*）来自 profile
  const anchor = specifier.startsWith("@deepseek-ai/") ? harnessAnchor() : installAnchor();
  return createRequire(anchor).resolve(specifier);
}

/** harness 安装的模块根（错误信息与诊断用） */
export function harnessRoot() {
  return dirname(dirname(dirname(resolveFrom(PROBE))));
}

let hooked = false;

/**
 * 把本仓库发出的 `@deepseek-ai/*` 裸请求改派到 harness 安装。
 * 参数是「要改派的目录」（一般是仓库根：插件产物在那里）；幂等，重复调用无效。
 */
export function registerHarnessHook(repoRoot = process.cwd()) {
  if (hooked) return;
  hooked = true;
  const root = resolve(repoRoot) + sep;
  const isScoped = (specifier) => specifier === "@deepseek-ai" || specifier.startsWith("@deepseek-ai/");
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (!isScoped(specifier) || context.parentURL === undefined) return nextResolve(specifier, context);
      let parent;
      try {
        parent = realpathSync(new URL(context.parentURL));
      } catch {
        return nextResolve(specifier, context);
      }
      if (!parent.startsWith(root)) return nextResolve(specifier, context);
      return { url: pathToFileURL(resolveFrom(specifier)).href, shortCircuit: true };
    },
  });
}
