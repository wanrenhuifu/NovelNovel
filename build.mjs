// 构建 dsh 插件包的两个半边：
//
// 1. `lib/index.js`——宿主半边（Node ESM）。external 的两类依赖：
//    - @deepseek-ai/*：运行时的 harness 真品，由 profile 的模块后备机制解析。绝不能内联，
//      服务按模块实例注册，双份会重复注册。
//    - @lenml/char-card-reader：第三方运行时依赖（AGPL），作为 dependencies 安装而非打进产物。
// 2. `lib/client.js`——客户端半边（浏览器经典脚本），见 build.client.mjs。
//
// **两个产物必须同时成功**：宿主 `ClientModuleRegistry` 构造时会对每个声明了 `dsh.client`
// 的 loader 行读 `exports["./client"]`，读不到就同步抛（`MissingClientBundleError` 聚合成
// `ClientPackageCompositionError`）→ 注册表不注册 → **所有**客户端插件（含首方 UI）都加载不出来。
// 所以这里不做「一个失败另一个继续」：任一 throw 就让整个 build 失败，装不上也就炸不了别人的界面。
// 判据在 `scripts/test-manifest.mjs`（装之前跑，不依赖 harness）。
//
// 路径基于本文件位置解析，从任何目录调用 npm run build 都能正确落盘。
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { buildClient } from "./build.client.mjs";

const packageDir = fileURLToPath(new URL(".", import.meta.url));

await build({
  entryPoints: [fileURLToPath(new URL("src/index.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("lib/index.js", import.meta.url)),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  external: ["@deepseek-ai/*", "@lenml/char-card-reader"],
  logLevel: "info",
  absWorkingDir: packageDir,
});

await buildClient();
