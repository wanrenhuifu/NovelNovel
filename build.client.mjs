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
// 浏览器 console 报 `missed the module table`（服务端看不到），所以只列实测过的键。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageDir = fileURLToPath(new URL(".", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8"));

/** 外壳的静态模块表（实测自 dsh-web-frontend 入口产物的 rM()） */
const PLATFORM_MODULES = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-client-store",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-dockkit",
];

export async function buildClient() {
  await build({
    entryPoints: [fileURLToPath(new URL("src/client/index.tsx", import.meta.url))],
    outfile: fileURLToPath(new URL("lib/client.js", import.meta.url)),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    external: PLATFORM_MODULES,
    legalComments: "none",
    logLevel: "info",
    absWorkingDir: packageDir,
    banner: {
      js: `window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(pkg.name)},\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };`,
    },
    footer: { js: "\t\treturn module.exports;\n\t}\n});" },
  });
}
