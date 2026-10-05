// 构建客户端半边：src/client/index.tsx → lib/client.js
//
// 产物形态由宿主决定，**不是 ESM 也不是 Node CJS 模块**，而是一段经典
// `<script>`（宿主渲染时没有 type="module"）：
//
//   window.__ModuleLoader__.load({ id: "<package.json name>", factory: (require) => {
//     var module = { exports: {} };
//     ...bundle...
//     return module.exports;
//   } });
//
// 因此这里用 esbuild 的 iife + banner/footer 手工补上外壳与「返回 module.exports」。
//
// external 只能是外壳**静态模块表**（PLATFORM_MODULES）里的精确键——命中即由外壳提供，
// 既不打进产物、也不需要任何声明。其余一律 inline。多写一个或漏掉一个，运行时会在
// 浏览器 console 报 `missed the module table`（服务端看不到）。
// 那份清单的唯一来源是 scripts/client-platform-modules.mjs（测试也读它）。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { PLATFORM_MODULES } from "./scripts/client-platform-modules.mjs";

const packageDir = fileURLToPath(new URL(".", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8"));

export async function buildClient() {
  await build({
    entryPoints: [fileURLToPath(new URL("src/client/index.tsx", import.meta.url))],
    outfile: fileURLToPath(new URL("lib/client.js", import.meta.url)),
    bundle: true,
    // 必须是 cjs：只有 cjs 形态的产出才会写 `module.exports = __toCommonJS(...)`。
    // 用 iife 的话 esbuild 只在有 globalName 时才赋值，我们这种"由外壳装载"的用法
    // 拿到的会是 banner 里那个空对象 → cordis Loader 报
    // `invalid plugin, expect function or object with an "apply" method`。
    format: "cjs",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    external: PLATFORM_MODULES,
    legalComments: "none",
    logLevel: "info",
    absWorkingDir: packageDir,
    banner: {
      // 对齐首方形态：`exports` 必须指向 module.exports，否则 cjs 产出里的
      // `exports.apply = …` 写丢了，factory 返回的还是空对象。
      js:
        `window.__ModuleLoader__.load({\n` +
        `\tid: ${JSON.stringify(pkg.name)},\n` +
        `\tfactory: (require) => {\n` +
        `\t\tvar module = { exports: {} };\n` +
        `\t\tvar exports = module.exports;\n` +
        `\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });`,
    },
    footer: { js: "\t\treturn module.exports;\n\t}\n});" },
  });
}
