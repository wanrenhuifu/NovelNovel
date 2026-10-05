// 面板渲染测试的支撑：把平台组件库换成 shim，这样能在 Node 里用 react-dom/server
// **真渲染** `NovelPanel` 整棵树（不复制面板代码——复制的测试只能验证副本）。
//
// 为什么值得做：面板从没在浏览器里跑过，而它两次让整个前端崩掉。服务端渲染抓不到 CSS 与交互，
// 但能抓到：JSX 层面的崩溃、宿主数据形状不对时的崩溃、以及"某块 UI 该出现却没出现"。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

/**
 * 平台组件库的 shim：每个名字渲染成带 `data-prim` 标记的元素，
 * 这样断言既能检查内容、也能检查"渲染的是哪个组件"。
 *
 * 用 esbuild 的 `alias` 顶替（**不要**试着往 `node_modules/@deepseek-ai/...` 里写文件——
 * 那条路径与真包重合，写进去就是在改别人的依赖）。
 */
const PRIMITIVES_SHIM = `
import { createElement as h } from "react";

export function Button(props) {
  return h("button", { "data-prim": "button", "data-size": props.size ?? "" }, props.children);
}
export function Tag(props) {
  return h("span", { "data-prim": "tag" }, props.children);
}
export function IconListPenOutlineRegular(props) {
  return h("svg", { "data-prim": "icon", "data-size": String(props.size ?? "") });
}
export function MarkdownText(props) {
  return h("div", { "data-prim": "markdown" }, props.text ?? props.children);
}
`;

/**
 * 打包面板到仓库内（好让 `react` 这类裸 import 解析到真 React），返回产物路径。
 * 产物导出 `NovelPanel` / `PanelContext` / `INITIAL`——三者同属一个 bundle，
 * 所以 Context 实例与面板内部 `usePanel()` 读到的是同一个。
 *
 * 产物与 shim 都落在 `node_modules/.cache/` 下：既解析得到，又已在 .gitignore 里。
 */
export async function buildPanelForRender(repo) {
  const cacheDir = join(repo, "node_modules", ".cache", "nn-panel-render");
  mkdirSync(cacheDir, { recursive: true });
  const shimFile = join(cacheDir, "primitives-shim.mjs");
  writeFileSync(shimFile, PRIMITIVES_SHIM, "utf8");

  // 测试入口：从**真源码**再导出面板与 Context（相对路径回到仓库）
  const entry = join(cacheDir, "entry.tsx");
  const toSrc = "../../../src/client";
  writeFileSync(
    entry,
    [
      `export { NovelPanel } from "${toSrc}/panel";`,
      `export { PanelContext, INITIAL } from "${toSrc}/state";`,
    ].join("\n"),
    "utf8",
  );

  const outfile = join(cacheDir, "panel.mjs");
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    jsx: "automatic",
    // 平台组件库换成 shim；react 外置（仓库里有真的，产物也在仓库内，解析得到）
    alias: { "@deepseek-ai/dsh-client-ui-primitives": shimFile },
    external: ["react", "react/jsx-runtime"],
    absWorkingDir: repo,
    logLevel: "error",
  });
  return outfile;
}
