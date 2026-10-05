// 归一化函数的单测：喂各种坏形状，断言不抛错且结果可用。
//
// 存在的理由：这些数据来自**给人手改的** JSON（lorebook.json / chapters/index.json），
// 宿主只判「能不能解析」，不判形状。缺一个字段就让面板整片空白过一次，所以这里把
// 坏形状逐个钉住。
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = fileURLToPath(new URL("..", import.meta.url));
const outfile = join(tmpdir(), `nn-normalize-${String(process.pid)}.mjs`);

await build({
  entryPoints: [join(repo, "src", "client", "normalize.ts")],
  outfile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  logLevel: "error",
});

const { normalizeChapters, normalizeLorebook, normalizeDetail } = await import(pathToFileURL(outfile).href);
rmSync(outfile, { force: true });

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) {
    passed++;
    console.log(`✓ ${name}`);
  } else {
    failed++;
    console.log(`✗ ${name}${detail === undefined ? "" : `  (${detail})`}`);
  }
};

// ── 坏形状一律不抛错 ────────────────────────────────────────────
const chapterCases = [
  ["undefined", undefined],
  ["null", null],
  ["字符串", "不是数组"],
  ["对象", { id: "x" }],
  ["空数组", []],
  ["条目是 null", [null]],
  ["条目是字符串", ["x"]],
  ["缺 tags", [{ id: "c1", title: "第一章", words: 100 }]],
  ["tags 是字符串", [{ id: "c1", title: "第一章", tags: "不是数组" }]],
  ["tags 混类型", [{ id: "c1", title: "第一章", tags: ["a", 1, null] }]],
  ["words 是字符串", [{ id: "c1", title: "第一章", words: "100" }]],
  ["全空对象", [{}]],
];

for (const [label, input] of chapterCases) {
  try {
    const out = normalizeChapters(input);
    check(`章节归一化不抛错：${label}`, Array.isArray(out));
  } catch (error) {
    check(`章节归一化不抛错：${label}`, false, String(error.message));
  }
}

// ── 语义：缺字段给出可用的兜底 ──────────────────────────────────
{
  const out = normalizeChapters([{ id: "c1", title: "第一章", words: 123 }]);
  check("缺 tags → 空数组", Array.isArray(out[0].tags) && out[0].tags.length === 0);
  check("words 保留", out[0].words === 123);
}
{
  const out = normalizeChapters([{ id: "c1", tags: ["伏笔", 1, "高潮", null] }]);
  check("tags 过滤非字符串", JSON.stringify(out[0].tags) === JSON.stringify(["伏笔", "高潮"]), JSON.stringify(out[0].tags));
  check("缺 title → 兜底标题", out[0].title === "（无标题）", out[0].title);
}
{
  const out = normalizeChapters([{ id: "c1", title: "第一章", words: Number.POSITIVE_INFINITY }]);
  check("words 为 Infinity → 0", out[0].words === 0, String(out[0].words));
}

// ── 词条：缺 keys 是这次差点炸掉面板的那种 ──────────────────────
{
  const out = normalizeLorebook([{ id: "l1", name: "设定", enabled: true }]);
  check("缺 keys → 空串（不会让 .split 抛错）", out[0].keys === "", JSON.stringify(out[0].keys));
  check("缺 keys → split 可用", out[0].keys.split(/[,，]/).length === 1);
}
{
  const out = normalizeLorebook([{ id: "l1", name: "设定" }]);
  check("缺 enabled → 视为启用", out[0].enabled === true);
}
{
  const out = normalizeLorebook([{ id: "l1", name: "设定", enabled: "yes" }]);
  // 认不出的值按「启用」处理：词条是用户的配置，静默关掉比多注入一条更糟
  check("enabled 非布尔 → 按启用处理（不静默关掉用户词条）", out[0].enabled === true, String(out[0].enabled));
}
check("词条非数组 → 空数组", normalizeLorebook("坏数据").length === 0);

// ── 详情：作品本体缺失时返回 null，让面板走空态 ─────────────────
check("详情 undefined → null", normalizeDetail(undefined) === null);
check("详情缺 project → null", normalizeDetail({ chapters: [] }) === null);
check("详情 project 不是对象 → null", normalizeDetail({ project: "坏" }) === null);
{
  const out = normalizeDetail({
    project: { id: "p1", title: "书", synopsis: "简介" },
    chapters: [{ id: "c1", title: "第一章" }],
    characters: [{ id: "k1", name: "林晚", active: true }],
    lorebook: [{ id: "l1", name: "设定" }],
  });
  check("正常详情可归一化", out !== null && out.chapters.length === 1 && out.characters.length === 1);
  check("角色缺 description → 空串", out.characters[0].description === "");
  check("详情缺 updatedAt → 0", out.project.updatedAt === 0);
}
{
  const out = normalizeDetail({ project: { title: "只有标题" }, chapters: "坏", characters: null, lorebook: 42 });
  check("详情子字段全坏 → 空数组而不是抛错", out !== null && out.chapters.length === 0 && out.characters.length === 0 && out.lorebook.length === 0);
}

console.log(`\n${failed === 0 ? "全部通过" : `${String(failed)} 项失败`}：${String(passed + failed)} 项检查`);
process.exit(failed === 0 ? 0 : 1);
