/**
 * 客户端半边（lib/client.js）的静态与冒烟测试。
 *
 * 两层检查：
 *  1. 产物格式——必须是一段经典 `<script>`（`__ModuleLoader__.load({id, factory})`），
 *     不是 ESM；`require` 的说明符必须全部落在外壳的静态模块表里。漏项或多写会在
 *     **浏览器 console** 报 `missed the module table`，服务端完全看不到，所以必须自动测。
 *  2. 冒烟执行——在最小 DOM 桩里物化 factory（bundle 只注册、不执行，是官方的惰性机制），
 *     验证两个 slot 都注册了、sidebar 的 id 与 main 的 key 一致、组件能渲染。
 *
 * 这里**测不到**、必须在真实浏览器里看的：外观、交互、fetch 是否被 connection 的 fence 放行。
 * 清单层面的判定（`dsh.client` 声明、`exports["./client"]`、产物路径）见 test-client-manifest.mjs。
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename } from "node:path";
import vm from "node:vm";
import { PLATFORM_MODULES } from "./client-platform-modules.mjs";

const bundlePath = fileURLToPath(new URL("../lib/client.js", import.meta.url));

// 门禁：产物缺失时给修法，而不是一句 ENOENT。
// 这不是友好提示——`dsh.client` 声明 + 产物缺失会让宿主在启动时**同步抛出**
// （client-modules: client bundle not found），整个前端（含首方插件）都加载不出来。
if (!existsSync(bundlePath)) {
  console.error(
    [
      "✗ 缺少客户端产物 lib/client.js。",
      "",
      "  本包声明了 dsh.client（客户端半边），宿主启动时会读取该产物：读不到会抛",
      "  `client-modules: client bundle not found`，并导致整个前端无法加载。先构建：",
      "",
      "    npm run build",
    ].join("\n"),
  );
  process.exit(1);
}

const code = readFileSync(bundlePath, "utf8");
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail: ok ? undefined : detail });

// ── 1. 产物格式 ────────────────────────────────────────────────
check("以 __ModuleLoader__.load 开头", code.startsWith("window.__ModuleLoader__.load({"));
check(`id 是包名 ${pkg.name}`, code.includes(`id: ${JSON.stringify(pkg.name)}`));
check("factory 接收 require", /factory: \(require\) => \{/.test(code));
check("factory 返回 module.exports", code.includes("return module.exports;"));
check("没有 ESM import 语句", !/^\s*import[\s{]/m.test(code));
check("未内联 React 实现", !code.includes("react.development") && !code.includes("useSyncExternalStore"));

const specs = new Set();
for (const m of code.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) specs.add(m[1]);
const strays = [...specs].filter((s) => !PLATFORM_MODULES.includes(s));
check("require 全部命中平台键", strays.length === 0, strays.join(", "));

// ── 2. 冒烟执行 ────────────────────────────────────────────────
const head = [];
const documentStub = {
  head: { appendChild: (el) => head.push(el) },
  getElementById: () => null,
  createElement: () => ({ dataset: {}, style: {}, textContent: "", remove() {} }),
  documentElement: { dataset: {} },
  addEventListener() {},
  removeEventListener() {},
  body: { appendChild() {} },
};

const missing = [];
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => undefined],
  useEffect: () => undefined,
  useMemo: (factory) => factory(),
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
  createContext: (value) => ({ Provider: (props) => props, _value: value }),
  useContext: (context) => context?._value,
};
const jsxStub = {
  jsx: (type, props) => ({ type, props }),
  jsxs: (type, props) => ({ type, props }),
  Fragment: Symbol("Fragment"),
};
const iconStub = (props) => ({ type: "icon", props });

function seed(spec) {
  if (spec === "react") return reactStub;
  if (spec === "react/jsx-runtime") return jsxStub;
  if (spec === "@deepseek-ai/dsh-client-ui-primitives") {
    return {
      Button: iconStub,
      Tag: iconStub,
      StateDot: iconStub,
      IconFileRegular: iconStub,
      IconFolderRegular: iconStub,
    };
  }
  return {};
}

const requireStub = (spec) => {
  if (!PLATFORM_MODULES.includes(spec)) {
    missing.push(spec);
    throw new Error(`client-modules: require("${spec}") missed the module table`);
  }
  return seed(spec);
};

const registrations = [];
const injectedKeys = [];
const ctxStub = {
  slots: {
    inject(key, callback) {
      injectedKeys.push(key);
      const dispose = callback(); // 声明已存在 → 同步执行
      return () => dispose?.();
    },
    register(definition, component) {
      registrations.push({ definition, component });
      return () => undefined;
    },
  },
  on: () => () => undefined,
  effect: (callback) => {
    callback();
    return () => undefined;
  },
};

let loaded = null;
const sandbox = {
  window: { __ModuleLoader__: { load: (record) => (loaded = record) } },
  document: documentStub,
  console,
  setTimeout,
  clearTimeout,
  URL,
  fetch: () => Promise.reject(new Error("smoke test does not fetch")),
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
// 刻意**不注入全局 ctx**：真实外壳从不定义它（bootInjections 只给 __ModuleLoader__ 与
// __DSH_BOOT__）。以前这里补了一个，正好把"顶层引用全局 ctx"这个致命缺陷遮住了。
vm.runInContext(code, sandbox, { filename: basename(bundlePath) });

check("调用了 __ModuleLoader__.load", loaded !== null);
check("factory 是函数", typeof loaded?.factory === "function");

/**
 * 最关键的一条：外壳把 factory 的返回值交给 cordis Loader，后者要求
 * 「函数，或带 apply 方法的对象」，否则抛
 * `invalid plugin, expect function or object with an "apply" method`。
 * 空对象意味着插件在浏览器里**根本装不上**——这正是曾经线上从没出现过面板的原因。
 */
let mod = null;
if (typeof loaded?.factory === "function") {
  try {
    mod = loaded.factory(requireStub);
    check("factory 可物化", true);
  } catch (error) {
    check("factory 可物化", false, String(error.message));
  }
}
check(
  "factory 返回值是带 apply 的对象（cordis 插件形态）",
  mod !== null && typeof mod === "object" && typeof mod.apply === "function",
  mod === null ? "factory 没返回东西" : `keys=[${Object.keys(mod).join(", ")}]`,
);
check(
  "导出了 inject 声明需要 slots",
  Array.isArray(mod?.inject) && mod.inject.includes("slots"),
  JSON.stringify(mod?.inject),
);

// 真正调用 apply（外壳就是这么做的），注册行为必须发生在这里
if (typeof mod?.apply === "function") {
  try {
    mod.apply(ctxStub);
    check("apply(ctx) 可执行", true);
  } catch (error) {
    check("apply(ctx) 可执行", false, String(error.message));
  }
}

check("require 无漏项", missing.length === 0, missing.join(", "));
check("注入了样式", head.length === 1);
check("注册了 sidebar.panellist", injectedKeys.includes("sidebar.panellist"), injectedKeys.join(", "));
check("注册了 main", injectedKeys.includes("main"));

const sidebar = registrations.find((r) => r.definition.name === "sidebar.panellist");
const main = registrations.find((r) => r.definition.name === "main");
check(
  "sidebar 带 id 与 order",
  sidebar?.definition.id === pkg.name && typeof sidebar?.definition.order === "number",
);
check("sidebar 带 label", typeof sidebar?.definition.label === "string");
check(
  "sidebar.id 与 main.key 一致",
  sidebar !== undefined && sidebar.definition.id === main?.definition.key,
  `id=${String(sidebar?.definition.id)} key=${String(main?.definition.key)}`,
);
for (const [name, entry] of [
  ["侧栏图标", sidebar],
  ["主面板", main],
]) {
  try {
    const rendered = entry?.component({});
    check(`${name}可渲染`, rendered !== null && rendered !== undefined);
  } catch (error) {
    check(`${name}可渲染`, false, String(error.message));
  }
}

// ── 汇总 ───────────────────────────────────────────────────────
const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? "✓" : "✗"} ${c.name}${c.detail === undefined ? "" : `  (${c.detail})`}`);
console.log(
  `\n${failed.length === 0 ? "全部通过" : `${String(failed.length)} 项失败`}：${String(checks.length)} 项检查` +
    `（产物 ${String(code.length)} 字符，require: ${[...specs].join(", ") || "无"}）`,
);
process.exit(failed.length === 0 ? 0 : 1);
