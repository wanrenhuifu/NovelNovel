// 构建 dsh 插件包：把插件源码与 src/domain 的领域逻辑打包成自包含的 lib/index.js。
//
// external 的两类依赖：
// - @deepseek-ai/*：运行时的 harness 真品，由 profile 的模块后备机制解析。绝不能内联，
//   服务按模块实例注册，双份会重复注册。
// - @lenml/char-card-reader：第三方运行时依赖（AGPL），作为 dependencies 安装而非打进产物。
//
// 路径基于本文件位置解析，从任何目录调用 npm run build 都能正确落盘。
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

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
