/**
 * 清单层校验：本包**两个半边**的产物与声明必须同时成立。
 *
 * 存在的理由是一次真实事故：`package.json` 里声明了 `dsh.client`，但产物 `lib/client.js`
 * 还没构建。宿主 `ClientModuleRegistry` 构造时会为每个 loader 行读 `exports["./client"]`
 * 指向的文件——`ENOENT` → `MissingClientBundleError` → 聚合为 `ClientPackageCompositionError`
 * **同步抛出**（`dsh-client-modules/lib/index.js` 的构造函数里那一句 `throw`）：
 * 注册表不注册 → `/plugins` 路由与 `window.__DSH_BOOT__` 注入都不发生 →
 * **整个前端**（含首方插件）都加载不出来。
 *
 * 也就是说这不是「插件自己的问题」，而是「启动即崩」，而且现场看起来像「这个插件和别的插件冲突」。
 * 所以本文件是**装机前的闸门**：判定全部按宿主真实读取规则复刻，不装 harness 也能跑。
 *
 * 两段职责：
 *   A. 宿主半边：`lib/index.js` 存在且非空，`main`/`exports["."]` 指向它。
 *   B. 客户端半边：`dsh.client` 声明与 `exports["./client"]` 产物**同时**成立（缺一即失败）。
 *
 * 与 `tests/verify-client-primitives.mjs` 的分工：那个校验「import 的名字在真实库里存在」，
 * 需要 Electron Node 才能读 asar；本文件只读本仓库，能在任何 `npm test` 里跑。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { PLATFORM_MODULES } from "./client-platform-modules.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail: ok ? undefined : detail });

// ── A. 宿主半边 ───────────────────────────────────────────────────
const mainEntry = pkg.exports?.["."] ?? pkg.main;
check(
  'exports["."]/main 指向 lib/index.js',
  mainEntry === "./lib/index.js" || mainEntry === "lib/index.js",
  String(mainEntry),
);

const hostPath = join(root, "lib/index.js");
const hostExists = existsSync(hostPath);
check("宿主产物存在（lib/index.js）", hostExists, "先跑 npm run build");
if (hostExists) {
  const size = statSync(hostPath).size;
  check("宿主产物非空", size > 0, `${String(size)} 字节`);
}

// ── B. 客户端半边 ─────────────────────────────────────────────────
/** 宿主 clientExportOf()：接受字符串，或带字符串 default 的对象 */
function clientExportOf(exportsField) {
  if (typeof exportsField !== "object" || exportsField === null) return { kind: "absent" };
  const client = exportsField["./client"];
  if (client === undefined) return { kind: "absent" };
  if (typeof client === "string") return { kind: "path", path: client };
  if (typeof client === "object" && client !== null && typeof client.default === "string") {
    return { kind: "path", path: client.default };
  }
  return { kind: "malformed" };
}

const decl = pkg.dsh?.client;
const exported = clientExportOf(pkg.exports);

check(
  "声明了 dsh.client（不是纯宿主插件了）",
  decl !== undefined,
  "本包现在带侧栏面板；若真要走纯宿主形态，必须同时删掉 exports[./client] 与 lib/client.js",
);
check("dsh.client 是对象", typeof decl === "object" && decl !== null);
check("dsh.client.platform 是字符串", typeof decl.platform === "string", String(typeof decl.platform));
check(
  'dsh.client.platform === "web"',
  decl?.platform === "web",
  `实际是 ${JSON.stringify(decl?.platform)}——非 web 会被宿主**静默**忽略（无构建、无报错、页面里也没有）`,
);

for (const field of ["inject", "external"]) {
  const value = decl?.[field];
  const ok =
    value === undefined || (Array.isArray(value) && value.every((item) => typeof item === "string"));
  check(`dsh.client.${field} 是字符串数组（若存在）`, ok, JSON.stringify(value));
}

const selfReference = Array.isArray(decl?.external)
  ? decl.external.filter((name) => name === pkg.name || name === `${pkg.name}/client`)
  : [];
check(
  "dsh.client.external 不包含自己",
  selfReference.length === 0,
  `含 ${selfReference.join(", ")}——宿主抛 "a row must not declare its own package"`,
);

const known = new Set(PLATFORM_MODULES);
const unknownExternal = Array.isArray(decl?.external)
  ? decl.external.filter((name) => !known.has(name))
  : [];
check(
  "dsh.client.external 里的键都在平台表内",
  unknownExternal.length === 0,
  `${unknownExternal.join(", ")}——平台表之外的键必须是另一个插件 row，否则浏览器里 require 会抛`,
);

check(
  '声明了 dsh.client，exports["./client"] 必须存在且形态合法',
  exported.kind === "path",
  exported.kind === "malformed"
    ? "宿主抛 must be a string or an object with a string default"
    : '缺 exports["./client"]，宿主抛 declares dsh.client but exports no "./client" bundle',
);

if (exported.kind === "path") {
  const clientPath = join(root, exported.path);
  const exists = existsSync(clientPath);
  check(
    `客户端产物存在（${exported.path}）`,
    exists,
    "宿主抛 MissingClientBundleError → 前端整体加载失败。先跑 npm run build",
  );
  if (exists) {
    const size = statSync(clientPath).size;
    check("客户端产物非空", size > 0, `${String(size)} 字节`);
    const text = readFileSync(clientPath, "utf8");
    check(
      "产物是 __ModuleLoader__.load 包装",
      text.startsWith("window.__ModuleLoader__.load({"),
      "宿主把它当经典 script 加载（无 type=module），形态不对会在浏览器里静默失败",
    );
    check("产物 id 是包名", text.includes(`id: ${JSON.stringify(pkg.name)}`));

    /*
     * 平台键写错时（写成 `…/client` 之类）esbuild 会把它当普通包**打进产物**：
     * 构建成功、产物非空、清单也齐全，只有浏览器 console 报 `missed the module table`。
     * 所以这里反查产物里的 require 说明符：落在某个平台键的同一命名空间下、
     * 却不在表里的，就是拼错的平台键。
     */
    const required = [...text.matchAll(/require\((?:"|')([^"']+)(?:"|')\)/g)].map((m) => m[1]);
    const platformNamespaces = PLATFORM_MODULES.filter((name) => name.startsWith("@deepseek-ai/"));
    const nearMisses = required.filter((spec) => {
      if (known.has(spec)) return false;
      return platformNamespaces.some(
        (platform) => spec.startsWith(`${platform}/`) || platform.startsWith(`${spec}/`),
      );
    });
    check(
      "产物 require 的平台键没有近似拼错",
      nearMisses.length === 0,
      `${[...new Set(nearMisses)].join(", ")}——平台表里没有，浏览器里会报 missed the module table`,
    );
  }
}

const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? "✓" : "✗"} ${c.name}${c.detail === undefined ? "" : `  (${c.detail})`}`);
console.log(
  `\n${failed.length === 0 ? "全部通过" : `${String(failed.length)} 项失败`}：${String(checks.length)} 项检查` +
    `（dsh.client: ${decl === undefined ? "未声明" : `platform=${String(decl.platform)}`}）`,
);
process.exit(failed.length === 0 ? 0 : 1);
