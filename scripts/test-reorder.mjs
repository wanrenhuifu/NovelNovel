// 章节拖拽排序纯逻辑测试
// 源码用无扩展相对导入（Vite 风格），Node 直跑 TS 不认，先经 esbuild 打包到临时文件再测真代码
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const dir = mkdtempSync(join(tmpdir(), "nn-reorder-"));
const outFile = join(dir, "bundle.mjs");
await esbuild.build({
  stdin: {
    contents: 'export { computeReorder } from "./src/domain/reorder";',
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: outFile,
});
const { computeReorder } = await import(pathToFileURL(outFile).href);
rmSync(dir, { recursive: true, force: true });

const mk = (id, sortOrder, updatedAt = 0) => ({
  id,
  projectId: 1,
  title: `ch-${id}`,
  content: "",
  updatedAt,
  sortOrder,
});

let failed = 0;
function check(label, ok, extra = "") {
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` ${extra}` : ""}`);
}

function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

const chapters = () => [mk(1, 0), mk(2, 1), mk(3, 2)];

// 边界情况
check(
  "same id returns null",
  computeReorder(chapters(), 1, 1, "before") === null,
);
check(
  "missing drag id returns null",
  computeReorder(chapters(), 99, 1, "before") === null,
);
check(
  "missing target id returns null",
  computeReorder(chapters(), 1, 99, "before") === null,
);

// 各种位移
const r1 = computeReorder(chapters(), 1, 3, "after");
check(
  "1 after 3 → [2,3,1]",
  eq(r1.map((c) => c.id), [2, 3, 1]),
);

const r2 = computeReorder(chapters(), 3, 1, "before");
check(
  "3 before 1 → [3,1,2]",
  eq(r2.map((c) => c.id), [3, 1, 2]),
);

const r3 = computeReorder(chapters(), 1, 2, "before");
check(
  "1 before 2 (no effective change) → [1,2,3]",
  eq(r3.map((c) => c.id), [1, 2, 3]),
);

const r4 = computeReorder(chapters(), 1, 2, "after");
check(
  "1 after 2 → [2,1,3]",
  eq(r4.map((c) => c.id), [2, 1, 3]),
);

const r5 = computeReorder(chapters(), 2, 1, "before");
check(
  "2 before 1 → [2,1,3]",
  eq(r5.map((c) => c.id), [2, 1, 3]),
);

const r6 = computeReorder(chapters(), 2, 3, "after");
check(
  "2 after 3 → [1,3,2]",
  eq(r6.map((c) => c.id), [1, 3, 2]),
);

// sortOrder 规范化
const r7 = computeReorder([mk(1, 0), mk(2, 100), mk(3, 200)], 3, 1, "before");
check(
  "sortOrder normalized to 0..n-1",
  eq(r7.map((c) => c.sortOrder), [0, 1, 2]),
);

// 不污染输入
const input = chapters();
const before = input.map((c) => c.id);
computeReorder(input, 1, 2, "after");
check(
  "does not mutate input array",
  eq(input.map((c) => c.id), before),
);

// 乱序输入按 sortOrder 排序后再处理
const r8 = computeReorder([mk(2, 1), mk(1, 0), mk(3, 2)], 3, 1, "before");
check(
  "unsorted input → [3,1,2]",
  eq(r8.map((c) => c.id), [3, 1, 2]),
);

// 保留原始字段
const r9 = computeReorder(
  [
    { ...mk(1, 0), title: "第一章", content: "content-a" },
    { ...mk(2, 1), title: "第二章", content: "content-b" },
  ],
  1,
  2,
  "after",
);
check(
  "preserves content",
  r9[0].title === "第二章" && r9[0].content === "content-b" && r9[1].title === "第一章",
);

console.log(failed === 0 ? "\nall passed" : `\n${failed} failed`);
process.exit(failed ? 1 : 0);
