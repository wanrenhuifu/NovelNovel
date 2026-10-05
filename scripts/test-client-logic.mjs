// 客户端半边**纯逻辑**的单测：键盘导航、请求地址拼装、响应解析。
//
// 为什么值得单独测：这三个文件（`useChapterKeys.ts` / `api.ts` / `state.ts`）是面板里唯一
// "改了却从没在浏览器里验证过"的部分——而它们的错误表现是"面板显示错内容"或"按键跳错章"，
// 不是崩溃，所以既不会被冒烟测试抓到，也不会有报错。抽出来的这三个函数覆盖了其中的判定逻辑。
//
// 用普通 Node 跑（不需要 DSH 的 Electron Node）：它们不碰 harness。
import esbuild from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "nn-client-"));
const outFile = join(dir, "bundle.mjs");
await esbuild.build({
  stdin: {
    contents: [
      'export { stepForKey, nextChapterId } from "./src/client/useChapterKeys";',
      'export { buildRequestTarget, parseResponse, ApiFailure } from "./src/client/api";',
    ].join("\n"),
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  jsx: "automatic",
  // React **打进测试包**：产物在 %TEMP% 里解析不到仓库的 node_modules。
  // 这里只为跑纯函数，进程内的这份副本与别处无关。
  outfile: outFile,
  logLevel: "error",
});

const { stepForKey, nextChapterId, buildRequestTarget, parseResponse, ApiFailure } = await import(
  pathToFileURL(outFile).href
);
rmSync(dir, { recursive: true, force: true });

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`✓ ${label}`);
  } else {
    failed++;
    console.log(`✗ ${label}  实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
  }
};

const chapters = [{ id: "a" }, { id: "b" }, { id: "c" }];

console.log("--- 键盘步进 ---");
check("ArrowDown → +1", stepForKey({ key: "ArrowDown" }), 1);
check("ArrowUp → -1", stepForKey({ key: "ArrowUp" }), -1);
check("j → +1", stepForKey({ key: "j" }), 1);
check("k → -1", stepForKey({ key: "k" }), -1);
check("Home 不处理（不抢别处的既定含义）", stepForKey({ key: "Home" }), 0);
check("End 不处理", stepForKey({ key: "End" }), 0);
check("PageDown 不处理", stepForKey({ key: "PageDown" }), 0);
check("带 Ctrl 的组合放行", stepForKey({ key: "j", ctrlKey: true }), 0);
check("带 Meta 的组合放行", stepForKey({ key: "ArrowDown", metaKey: true }), 0);
check("带 Alt 的组合放行", stepForKey({ key: "k", altKey: true }), 0);
check("带 Shift 的组合放行", stepForKey({ key: "ArrowDown", shiftKey: true }), 0);

console.log("--- 章节跳转（含未选中的 off-by-one）---");
check("选中 b 按 ↓ → c", nextChapterId(chapters, "b", 1), "c");
check("选中 b 按 ↑ → a", nextChapterId(chapters, "b", -1), "a");
// 这条是曾经的真实 bug：`found = -1` 被归到 0，于是第一次按 ↓ 落到第 2 章，第 1 章永远按不到
check("未选中（null）按 ↓ → 第 1 章", nextChapterId(chapters, null, 1), "a");
check("currentId 不在列表里按 ↓ → 第 1 章", nextChapterId(chapters, "zzz", 1), "a");
check("未选中按 ↑ → 不动（-2 越界）", nextChapterId(chapters, null, -1), null);
check("第 1 章按 ↑ → 不循环到末尾", nextChapterId(chapters, "a", -1), null);
check("最后一章按 ↓ → 不循环到开头", nextChapterId(chapters, "c", 1), null);
check("空列表 → 不动", nextChapterId([], "a", 1), null);
check("step=0 → 不动", nextChapterId(chapters, "b", 0), null);

console.log("--- 请求地址拼装（文档相对）---");
check("去掉前导斜杠", buildRequestTarget("/api/novel.projects", {}), "api/novel.projects");
check("带查询参数", buildRequestTarget("/api/novel.chapter", { chapter: "c1" }), "api/novel.chapter?chapter=c1");
check(
  "cwd 为空串时不拼（空串会被后端当成「传了但为空」）",
  buildRequestTarget("/api/novel.projects", { cwd: "" }),
  "api/novel.projects",
);
check(
  "cwd 为 undefined 时不拼",
  buildRequestTarget("/api/novel.projects", { cwd: undefined }),
  "api/novel.projects",
);
check(
  "多个参数按插入顺序拼",
  buildRequestTarget("/api/novel.chapter", { project: "p1", chapter: "c1" }),
  "api/novel.chapter?project=p1&chapter=c1",
);
check("参数值需要转义", buildRequestTarget("/api/x", { q: "a b&c" }), "api/x?q=a+b%26c");
check("路径里的已有查询保留", buildRequestTarget("/api/x?v=1", {}), "api/x?v=1");
check("绝不返回以 / 开头的地址（否则会脱离反代前缀）", buildRequestTarget("/api/x", {}).startsWith("/"), false);

console.log("--- 响应解析 ---");
check("成功时解包 data", parseResponse(true, 200, { data: { ok: 1 } }), { ok: 1 });
{
  let thrown = null;
  try {
    parseResponse(false, 403, { error: { code: "unknown_workspace", message: "没有这个工作区" } });
  } catch (error) {
    thrown = error;
  }
  check("失败时抛 ApiFailure", thrown instanceof ApiFailure, true);
  check("保留 error.code", thrown?.code, "unknown_workspace");
  check("保留 error.message", thrown?.message, "没有这个工作区");
}
{
  let thrown = null;
  try {
    // 首方兜底会回**空 body**（比如 webserver 的 400）——不能让调用方拿到 undefined 就崩
    parseResponse(false, 400, undefined);
  } catch (error) {
    thrown = error;
  }
  check("空 body 时给出带状态码的兜底 code", thrown?.code, "http_400");
  check("空 body 时给出可读文案", thrown?.message, "request failed with 400");
}
{
  let thrown = null;
  try {
    parseResponse(false, 500, { error: { code: "internal_error", message: "x", extra: { known: ["a"] } } });
  } catch (error) {
    thrown = error;
  }
  check("透传 error.extra", thrown?.extra, { known: ["a"] });
}

console.log(`\n${failed === 0 ? "全部通过" : `${String(failed)} 项失败`}：${String(passed + failed)} 项检查`);
process.exit(failed === 0 ? 0 : 1);
