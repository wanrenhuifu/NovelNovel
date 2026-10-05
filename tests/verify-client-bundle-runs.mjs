/**
 * **执行交付产物本身**：把 `lib/client.js`（浏览器真正收到的那份字节）用假
 * `window.__ModuleLoader__` 加载进 Node，调 `apply(ctx)`，断言它注册了什么。
 *
 * 为什么这条不可替代：`test-client-bundle.mjs` 只做静态检查（包装格式、external 白名单），
 * `test:compose` 只验证**注册表能组合**，两者都**从不执行 factory**。于是"产物能跑起来并真的
 * 注册插槽"这件事没有任何测试——而这正是它在真实 app 里没生效时最需要区分的一环。
 *
 * 判据：`apply` 应当在 `sidebar.panellist` 上注册一个带 `id` 的条目、在 `main` 上注册一个
 * 带同名 `key` 的条目（两者靠这个 id/key 关联），并且返回可销毁的东西。
 *
 * 必须用 DSH 自带的 Electron Node 运行（react 等平台模块要按真品解析）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { load, registerHarnessHook } from "./harness-loader.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
registerHarnessHook(repo);

let passed = 0;
let failed = 0;
const check = (label, ok, extra = "") => {
  if (ok) {
    passed++;
    console.log(`✓ ${label}${extra ? `  ${extra}` : ""}`);
  } else {
    failed++;
    console.log(`✗ ${label}${extra ? `  ${extra}` : ""}`);
  }
};

const bundlePath = join(repo, "lib", "client.js");
const source = readFileSync(bundlePath, "utf8");
console.log(`--- 执行产物（${String(source.length)} 字符）---`);

// ── 搭一个最小的浏览器外壳 ────────────────────────────────────────
const loadCalls = [];
let loaded = null;
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      loadCalls.push(entry);
      loaded = entry;
    },
  },
  document: {
    // installStyles 会 createElement("style")、写 style.dataset.pluginCss、再塞进 head
    head: { appendChild: () => undefined, append: () => undefined },
    createElement: () => ({
      dataset: {},
      style: {},
      setAttribute: () => undefined,
      appendChild: () => undefined,
    }),
    querySelector: () => null,
    getElementById: () => null,
  },
};
globalThis.document = globalThis.window.document;

// 执行产物：它会调 window.__ModuleLoader__.load({ id, factory })
try {
  // 经典 script，不是模块：用 Function 在全局作用域下跑（与浏览器 <script> 同语义）
  new Function(source)();
  check("产物能在经典 script 语义下执行完", true);
} catch (error) {
  check("产物能在经典 script 语义下执行完", false, String(error?.message ?? error).slice(0, 140));
}

check("调用了一次 __ModuleLoader__.load", loadCalls.length === 1, String(loadCalls.length));
const entry = loaded ?? {};
check("id 是包名 dsh-novelnovel", entry.id === "dsh-novelnovel", String(entry.id));
check("提供了 factory", typeof entry.factory === "function", typeof entry.factory);

// ── 用真品模块喂 require，跑 factory ──────────────────────────────
const primitivesStub = {
  IconListPenOutlineRegular: () => null,
  Button: () => null,
  Tag: () => null,
  MarkdownText: () => null,
};

const requireShim = (specifier) => {
  // 外壳的静态模块表就是这个形状；这里只用得到这三个
  if (specifier === "react") return reactDefault;
  if (specifier === "react/jsx-runtime") return jsxRuntime;
  if (specifier === "@deepseek-ai/dsh-client-ui-primitives") return primitivesStub;
  throw new Error(`模块表里没有: ${specifier}`);
};
// react 与 jsx-runtime 从**仓库**的 node_modules 取（`@deepseek-ai/*` 才走 harness 安装）
const reactDefault = (await import("react")).default ?? (await import("react"));
const jsxRuntime = await import("react/jsx-runtime");

let exportsObject = null;
try {
  exportsObject = entry.factory(requireShim);
  check("factory 能跑完并返回 exports", typeof exportsObject === "object" && exportsObject !== null);
} catch (error) {
  check("factory 能跑完并返回 exports", false, String(error?.message ?? error).slice(0, 160));
}

check("导出了 apply（函数）", typeof exportsObject?.apply === "function", typeof exportsObject?.apply);
check(
  "声明了 inject 包含 slots",
  Array.isArray(exportsObject?.inject) && exportsObject.inject.includes("slots"),
  JSON.stringify(exportsObject?.inject),
);

// ── 调 apply，记录它注册了什么 ────────────────────────────────────
const registrations = [];
const injections = [];
const disposers = [];
const ctx = {
  slots: {
    inject(key, callback) {
      injections.push(key);
      // 真品语义：inject 在目标插槽可用时执行回调，返回可销毁项
      const dispose = callback();
      disposers.push(typeof dispose === "function" ? dispose : () => undefined);
      return () => undefined;
    },
    register(descriptor, component) {
      registrations.push({ descriptor, component });
      return () => undefined;
    },
  },
};

try {
  exportsObject.apply(ctx);
  check("apply(ctx) 不抛错", true);
} catch (error) {
  check("apply(ctx) 不抛错", false, String(error?.message ?? error).slice(0, 200));
}

console.log(`      注册到: ${JSON.stringify(registrations.map((r) => r.descriptor?.name))}`);
console.log(`      inject 目标: ${JSON.stringify(injections)}`);

check("向 sidebar.panellist 注册了条目", registrations.some((r) => r.descriptor?.name === "sidebar.panellist"));
check("向 main 注册了面板", registrations.some((r) => r.descriptor?.name === "main"));
{
  const icon = registrations.find((r) => r.descriptor?.name === "sidebar.panellist");
  const panel = registrations.find((r) => r.descriptor?.name === "main");
  check("侧栏条目带 id", typeof icon?.descriptor?.id === "string" && icon.descriptor.id !== "", String(icon?.descriptor?.id));
  check("侧栏条目带可读 label", icon?.descriptor?.label === "NovelNovel", String(icon?.descriptor?.label));
  check("两侧的 id/key 一致（唯一联系）", icon?.descriptor?.id === panel?.descriptor?.key, `${String(icon?.descriptor?.id)} vs ${String(panel?.descriptor?.key)}`);
  check("侧栏图标是可渲染的组件（函数）", typeof icon?.component === "function", typeof icon?.component);
  check("主面板是可渲染的组件（函数）", typeof panel?.component === "function", typeof panel?.component);
}
check("用了 slots.inject 而不是裸 register（等插槽可用）", injections.includes("sidebar.panellist") && injections.includes("main"), JSON.stringify(injections));

console.log(`\n${failed === 0 ? "全部通过" : `${String(failed)} 项失败`}：${String(passed + failed)} 项检查`);
process.exit(failed === 0 ? 0 : 1);
