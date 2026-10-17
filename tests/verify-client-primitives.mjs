/**
 * 校验客户端半边对外部的依赖假设，在**当前这版宿主**上仍然成立。
 *
 * 两件事，强弱不同：
 *
 * ① **平台模块表**（强，结构性的）：我们的 `lib/client.js` 里 `require(...)` 的每个说明符
 *    都必须是外壳**静态模块表**的键——写错或宿主升级删掉某个模块，只在**浏览器 console**
 *    报 `missed the module table`，服务端完全看不到，表现是"面板凭空消失"。
 *    所以这里直接从**安装里的前端产物**把那张表挖出来比对，而不是相信仓库里手抄的那份。
 *
 * ② **首方导出名**（弱，出现即报警）：`src/client/env.d.ts` 是手写声明，名字写错 `tsc` 拦不住
 *    （测试用自造桩），浏览器里会拿到 `undefined` 当组件用 → 整棵 React 树抛错。真实事故：
 *    用了 `IconFolderRegular`，而库里只有 `IconFolderOpenRegular`。
 *
 *    **0.2.1-rc.2 起这条只能降级**：`@deepseek-ai/dsh-client-ui-primitives` 不再是安装里的
 *    独立 npm 包（0.2.0 时是），它被打进了 `dsh-web-frontend` 的 bundle，模块表里
 *    `"…/dsh-client-ui-primitives" → <打包器内部标识符>`，没有可解析的导出字面量。
 *    所以：包还在时（老宿主）做**严格核对**；包没了就退化成"名字在产物里出现过"，
 *    并**明说这不是证明**——真正的证明是 `test:bundle-runs`（真跑 apply）+ 真浏览器里看一眼
 *    （`.ref/shot-cdp.mjs` 那套，见 AGENTS.md）。
 *
 * 必须用 DSH 自带的 Electron Node 运行（asar 里的文件只有带 asar 支持的进程读得到），
 * 所以由 scripts/verify-client-primitives.mjs 启动，不要直接 node 跑。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PLATFORM_MODULES } from "../scripts/client-platform-modules.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail: ok ? undefined : detail });

// ── 1. 源码里从 primitives import 的名字，与客户端产物 require 的说明符 ──────
const clientDir = join(repo, "src", "client");
const sources = readdirSync(clientDir)
  .filter((f) => /\.tsx?$/.test(f))
  .map((f) => ({ name: f, text: readFileSync(join(clientDir, f), "utf8") }));

const imported = new Map();
const importRe = /import\s*(?:type\s*)?\{([^}]+)\}\s*from\s*["']@deepseek-ai\/dsh-client-ui-primitives["']/g;
for (const { name, text } of sources) {
  let m;
  while ((m = importRe.exec(text)) !== null) {
    for (const raw of m[1].split(",")) {
      const id = raw.trim().split(/\s+as\s+/)[0].trim();
      if (id !== "") imported.set(id, name);
    }
  }
}
check("源码里确实 import 了 primitives", imported.size > 0, `解析到 ${String(imported.size)} 个`);

const builtBundle = join(repo, "lib", "client.js");
check("存在构建产物 lib/client.js", existsSync(builtBundle));
const required = new Set(
  existsSync(builtBundle)
    ? [...readFileSync(builtBundle, "utf8").matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1])
    : [],
);

// ── 2. 从安装里的前端产物挖出平台模块表 ─────────────────────────────────
const install = process.env.DSH_INSTALL ?? "D:/DSH";
const assets = join(
  install, "resources", "app.asar", "dsh", "node_modules", "@deepseek-ai", "dsh-web-frontend", "dist", "assets",
);

/** 表所在的 bundle：含有我们某个说明符的那个 js 文件 */
function findBundle() {
  if (!existsSync(assets)) return undefined;
  const probe = [...required][0] ?? "@deepseek-ai/cordis";
  for (const file of readdirSync(assets).filter((f) => f.endsWith(".js"))) {
    const text = readFileSync(join(assets, file), "utf8");
    if (text.includes(JSON.stringify(probe).slice(1, -1))) return { file, text };
  }
  return undefined;
}

const bundle = findBundle();
check("能定位前端产物里的模块表", bundle !== undefined, `${assets} 下没找到含 require 说明符的 js`);

/**
 * 从 bundle 里把模块表那段对象字面量切出来。
 *
 * 不能直接在整份 bundle 上跑正则匹配 `key:value`——那是几 MB 的压缩代码，误匹配满地。
 * 做法：先锚定我们确定在表里的说明符，再向左右各找一层花括号并**配平**，切出表本身。
 * 注意键有两种写法：`react:sC`（合法标识符，不带引号）与 `"@deepseek-ai/…":zU`（带引号）。
 */
function extractTable(text) {
  const anchor = text.indexOf('"@deepseek-ai/dsh-client-ui-primitives"');
  if (anchor < 0) return undefined;
  const start = text.lastIndexOf("{", anchor);
  if (start < 0) return undefined;
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/** 表里的键：带引号与不带引号都要认 */
function tableKeys(table) {
  const keys = new Set();
  for (const m of table.matchAll(/(?:"([^"\\]{1,80})"|([A-Za-z_$][\w$.-]{0,79}))\s*:\s*[A-Za-z_$][\w$]*/g)) {
    keys.add(m[1] ?? m[2]);
  }
  return keys;
}

let keys = new Set();
if (bundle !== undefined) {
  const table = extractTable(bundle.text);
  if (table !== undefined) keys = tableKeys(table);
  console.log(`模块表来源: ${bundle.file}（切出 ${String(table?.length ?? 0)} 字符，抠到 ${String(keys.size)} 个键）`);
  if (keys.size > 0) console.log(`  ${[...keys].sort().join(", ")}`);
}

check("表里能找到 react（解析可靠）", keys.has("react"));
check("表里有 primitives 模块", keys.has("@deepseek-ai/dsh-client-ui-primitives"));
check("表里有 slots 模块", keys.has("@deepseek-ai/dsh-client-ui-slots"));

// 产物 require 的每个说明符都必须被外壳提供（否则浏览器里 missed the module table）
for (const spec of required) {
  check(`产物 require 的说明符在外壳表里：${spec}`, keys.has(spec), "外壳没提供它 → 面板会在浏览器里静默不出现");
}

// 仓库里手抄的清单不能多报（多了说明我们以为有、其实没有）
for (const spec of PLATFORM_MODULES) {
  check(`PLATFORM_MODULES 与外壳一致：${spec}`, keys.has(spec), "外壳里没有这个键");
}

// ── 3. 首方导出名：包在就严格核对，包没了就退化成"出现过"并明说 ──────────
const pkgRoot = join(
  install, "resources", "app.asar", "dsh", "node_modules", "@deepseek-ai", "dsh-client-ui-primitives",
);

if (existsSync(join(pkgRoot, "package.json"))) {
  let exported = new Set();
  const manifest = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
  const entry = typeof manifest.exports?.["."] === "string"
    ? manifest.exports["."]
    : (manifest.exports?.["."]?.default ?? manifest.main ?? "lib/index.js");
  const text = readFileSync(join(pkgRoot, entry), "utf8");
  for (const block of [...text.matchAll(/export\s*\{([^}]{0,80000})\}/g)].map((m) => m[1])) {
    for (const part of block.split(",")) {
      const cleaned = part.trim().split(/\s+as\s+/).pop().trim();
      if (cleaned !== "") exported.add(cleaned);
    }
  }
  console.log(`primitives 是独立包: ${entry}（${String(exported.size)} 个导出）`);
  check("导出名单可解析（打包形态未变）", exported.size > 100, `只解析到 ${String(exported.size)} 个`);
  for (const [name, file] of imported) {
    check(`primitives 导出存在：${name}`, exported.has(name), `${file} import 了它，但安装里的组件库没有这个导出`);
  }
} else {
  console.log("primitives 不再是独立包（0.2.1+ 打进了前端 bundle）→ 导出名核对降级为「名字出现过」");
  const text = bundle?.text ?? "";
  for (const [name] of imported) {
    // 出现形态：作为对象键（`X:`）或转义后的键（`"X":`）
    const appears = text.includes(`${name}:`) || text.includes(`"${name}":`);
    check(`组件名在产物里出现：${name}`, appears, "产物里找不到这个名字 → 组件可能是 undefined");
  }
  check(
    "降级核对已明示（不是导出证明）",
    true,
    undefined,
  );
}

// ── 汇总 ──────────────────────────────────────────────────────────────
const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? "✓" : "✗"} ${c.name}${c.detail === undefined ? "" : `  (${c.detail})`}`);
console.log(
  `\n${failed.length === 0 ? "全部通过" : `${String(failed.length)} 项失败`}：${String(checks.length)} 项检查` +
    `（import ${String(imported.size)} 个名字 / 外壳表 ${String(keys.size)} 个键 / 产物 require ${String(required.size)} 个）`,
);
process.exit(failed.length === 0 ? 0 : 1);
