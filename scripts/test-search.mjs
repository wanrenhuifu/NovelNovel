// 章节全文搜索测试：searchChapters 纯逻辑
// 源码用无扩展相对导入（Vite 风格），Node 直跑 TS 不认，先经 esbuild 打包到临时文件再测真代码
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const outFile = join(mkdtempSync(join(tmpdir(), "nn-search-")), "bundle.mjs");
await esbuild.build({
  stdin: {
    contents: 'export { searchChapters } from "./src/domain/search";',
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: outFile,
});
const { searchChapters } = await import(pathToFileURL(outFile).href);

let failed = 0;
function check(label, ok, extra = "") {
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` ${extra}` : ""}`);
}

const mk = (id, title, content) => ({
  id,
  projectId: 1,
  title,
  content,
  sortOrder: id,
  updatedAt: 0,
});

const chapters = [
  mk(1, "第一章 雪夜", "长安落了大雪。沈青梧站在楼顶，看着漫天飞雪。"),
  mk(2, "第二章 刺客", "刀光一闪。大雪里有人影掠过。"),
  mk(3, "第三章 空章", ""),
];

// ---- 基本匹配 ----
check("空查询返回空", searchChapters(chapters, "").length === 0);
check("纯空白查询返回空", searchChapters(chapters, "   ").length === 0);

const r1 = searchChapters(chapters, "大雪");
check("命中两处正文", r1.filter((r) => r.pos != null).length === 2);
check("结果按章节顺序", r1[0].chapterId === 1 && r1[1].chapterId === 2);

// pos 正确性：按 pos 切出的文本应等于查询词
const hit = r1[0];
const ch1 = chapters[0].content;
check(
  "pos 指向正文命中处",
  ch1.slice(hit.pos, hit.pos + 2).toLowerCase() === "大雪",
);

// 大小写不敏感（拉丁字符）
const latin = [mk(1, "T1", "Hello World, hello again.")];
check("大小写不敏感", searchChapters(latin, "HELLO").length === 2);

// ---- segments 摘要 ----
const long = [mk(1, "长章", "甲".repeat(50) + "关键词" + "乙".repeat(50))];
const seg = searchChapters(long, "关键词")[0].segments;
const hitSeg = seg.find((s) => s.hit);
check("hit 段为关键词本身", hitSeg?.text === "关键词");
check("前后有省略号标记", seg[0].text.startsWith("…") && seg[seg.length - 1].text.endsWith("…"));
check("摘要窗口截断", seg[0].text.length <= 20 && seg[seg.length - 1].text.length <= 20);

const head = searchChapters([mk(1, "T", "关键词在开头")], "关键词")[0].segments;
check("文首命中无前置省略号", !head[0].text.startsWith("…") && head[0].hit);

// 换行折叠为空格
const multiline = [mk(1, "T", "第一段结尾\n\n关键词在下一段")];
const ml = searchChapters(multiline, "关键词")[0].segments;
check("换行折叠为空格", !ml.some((s) => s.text.includes("\n")) && ml.some((s) => s.text.includes(" ")));

// ---- 标题命中 ----
const titleHits = searchChapters(chapters, "刺客");
check("标题命中 pos 为 null", titleHits.some((r) => r.pos === null && r.chapterId === 2));
check("标题命中带标记", titleHits.some((r) => r.segments[0].text.includes("标题命中")));

// ---- 上限 ----
const many = [mk(1, "T", "词".repeat(500))];
const capped = searchChapters(many, "词", { maxPerChapter: 5 });
check("单章命中数受限", capped.length === 5);

const manyChapters = Array.from({ length: 30 }, (_, i) => mk(i + 1, `C${i}`, "命中词在此"));
const totalCapped = searchChapters(manyChapters, "命中词", { maxPerChapter: 1, maxTotal: 10 });
check("总结果数受限", totalCapped.length === 10);

// ---- 全半角与长度变化的大小写折叠 ----
// 全角字母应与半角互相命中
check("全角查询命中半角正文", searchChapters([mk(1, "T", "abc 出现")], "ＡＢＣ").length === 1);
check("半角查询命中全角正文", searchChapters([mk(1, "T", "ＡＢＣ 出现")], "abc").length === 1);
// İ 的 toLowerCase 会变长：不能拿它当定位基准，否则 pos 与原文错位
const turkish = [mk(1, "T", "İstanbul 大雪")];
const tk = searchChapters(turkish, "stanbul");
check(
  "长度变化的小写折叠不吃掉命中",
  tk.length === 1,
  `命中 ${tk.length} 处`,
);
check(
  "命中位置仍与原文对齐",
  tk.length === 1 && turkish[0].content.slice(tk[0].pos, tk[0].pos + 7).toLowerCase() === "stanbul",
);

// maxTotal: 1 时标题命中不该把正文命中全吃掉
const titleAndBody = searchChapters([mk(1, "刺客", "刀光一闪，刺客退去。")], "刺客", {
  maxTotal: 2,
  maxPerChapter: 5,
});
check(
  "标题命中之后正文仍能拿到命中",
  titleAndBody.some((r) => r.pos === null) && titleAndBody.some((r) => r.pos != null),
);

// ---- 同一章多次命中按出现先后 ----
const order = searchChapters([mk(1, "T", "一啊二啊三")], "啊");
check("同章命中按出现顺序", order[0].pos < order[1].pos);

// ---- 摘要不能切在代理对中间 ----
// 摘要边界由"前后 N 个字符"算出来，emoji 占两个 UTF-16 码元，切中间会产出孤立代理
// （渲染成 U+FFFD）。这里断言产出的文本里没有孤立代理。
const loneSurrogate = (s) => {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
};
const emojiText = (s) => s.segments.map((seg) => seg.text).join("");

const emojiTitle = searchChapters([mk(1, "关键词", "abc" + "😀".repeat(19))], "关键词");
check("标题命中的摘要不含孤立代理", !loneSurrogate(emojiText(emojiTitle[0])), JSON.stringify(emojiText(emojiTitle[0])));

const emojiBody = searchChapters([mk(1, "T", "a" + "😀".repeat(20) + "b关键词")], "关键词");
check("正文命中的摘要不含孤立代理", !loneSurrogate(emojiText(emojiBody[0])), JSON.stringify(emojiText(emojiBody[0])));
check("命中片段本身完整", emojiBody[0].segments.some((s) => s.hit && s.text.includes("关键词")));

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
