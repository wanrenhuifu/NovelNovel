// domain 纯逻辑的杂项测试：字数统计与词条关键词匹配。
// 这两条都是「数字报给用户」「设定决定注不注入」的地方，静默错了很难被发现。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const outFile = join(mkdtempSync(join(tmpdir(), "nn-domain-")), "bundle.mjs");
await esbuild.build({
  stdin: {
    contents:
      'export { countWords } from "./src/domain/utils";\n' +
      'export { selectLoreEntries } from "./src/domain/prompt";',
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: outFile,
});
const { countWords, selectLoreEntries } = await import(pathToFileURL(outFile).href);

let failed = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(
    `${ok ? "✓" : "✗"} ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (期望 ${JSON.stringify(expected)})`}`,
  );
};

console.log("--- countWords ---");
check("空文本 0", countWords(""), 0);
check("纯空白 0", countWords("   \n  "), 0);
check("纯中文按字计", countWords("长夜将至"), 4);
// 标点不构成「字」：中文写作者不会把逗号句号算进字数
check("全角标点不计入", countWords("，" ), 0);
check("书名号不计入", countWords("《长安》"), 2);
check("中文标点夹在正文里", countWords("长夜，将至。"), 4);
check("中西混排", countWords("他说 hello world 然后走了"), 8);
// 阿拉伯数字按一个西文词计（与「汉字按字、其余按词」的口径一致）
check("数字算一个词", countWords("第 3 章"), 3);
// 扩展 B 区汉字是代理对，用不带的字符类只会算 1 个
check("扩展 B 区汉字按码点计 50 字", countWords("𠀋".repeat(50)), 50);
check("扩展 B 区与常用汉字混合", countWords("𠀋长"), 2);
check("英文标点也不计入", countWords("hello, world!"), 2);
// 零宽连接符（U+200D）与变体选择符（U+FE0F）既不是标点也不是符号，不剥掉就会被当"词"：
// 同一个 emoji 体系里 `👨‍👩‍👧` 报 2 个词而 `😀` 报 0 个，字数随 emoji 虚高。
check("单个 emoji 不计词", countWords("😀"), 0);
check("ZWJ 家庭 emoji 不计词（连接符不该被算成词）", countWords("👨‍👩‍👧"), 0);
check("带变体选择符的爱心不计词", countWords("❤️"), 0);
check("五个家庭 emoji 仍是 0 词", countWords("👨‍👩‍👧".repeat(5)), 0);
check("emoji 夹在汉字里只算汉字", countWords("他说😀然后走了"), 6);

console.log("--- selectLoreEntries ---");
const entry = (over) => ({ id: "e", name: "n", keys: "", content: "内容", enabled: true, ...over });
const ctx = "夜里他走进大祭司的祭坛，抬头看见血月。";

check("空 keys = 常驻", selectLoreEntries([entry({})], "").length, 1);
check("只有空白/逗号的 keys = 常驻（不是「命中任意文本」）",
  selectLoreEntries([entry({ keys: " , ， " })], "").length, 1);
check("命中关键词", selectLoreEntries([entry({ keys: "血月" })], ctx).length, 1);
check("未命中被排除", selectLoreEntries([entry({ keys: "太阳" })], ctx).length, 0);
check("多关键词任一命中", selectLoreEntries([entry({ keys: "太阳, 血月" })], ctx).length, 1);
check("全角逗号也能分隔", selectLoreEntries([entry({ keys: "太阳，血月" })], ctx).length, 1);
check("前导空格不影响", selectLoreEntries([entry({ keys: "  血月  " })], ctx).length, 1);
check("禁用条目永不注入", selectLoreEntries([entry({ keys: "血月", enabled: false })], ctx).length, 0);
check("空内容条目被排除", selectLoreEntries([entry({ keys: "血月", content: "  " })], ctx).length, 0);

// 全半角：全角关键词应命中半角上下文，反之亦然
check("全角关键词命中半角上下文", selectLoreEntries([entry({ keys: "ＡＢＣ" })], "abc 出现").length, 1);
check("半角关键词命中全角上下文", selectLoreEntries([entry({ keys: "abc" })], "ＡＢＣ 出现").length, 1);
check("全角空格归一化", selectLoreEntries([entry({ keys: "血 月" })], "血\u3000月").length, 1);

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
