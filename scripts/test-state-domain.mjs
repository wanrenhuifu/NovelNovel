// 状态层的纯逻辑测试（MVU 兼容协议）。
//
// 为什么单独测：`<UpdateVariable>` 是**模型写在正文里**的东西，形状完全不可控。判错一条的后果是
// 变量树被写坏（比如 delta 把字符串当数字、"人物" 被整体覆盖丢光）——而且不会报错，
// 只是下一章的世界状态悄悄错了。所以：坏形状必须逐条进 rejected，好形状必须一条不丢。
import { bundleSource } from "./bundle-source.mjs";

const { module } = await bundleSource(
  "state",
  'export { parseInitvar, extractUpdateBlocks, parseUpdateBlock, applyPatch, renderState } from "./src/domain/stateUpdate";\n',
);
const { parseInitvar, extractUpdateBlocks, parseUpdateBlock, applyPatch, renderState } = module;

let passed = 0;
let failed = 0;
const check = (label, ok, extra = "") => {
  if (ok) {
    passed += 1;
    console.log(`✓ ${label}${extra ? `  ${extra}` : ""}`);
  } else {
    failed += 1;
    console.log(`✗ ${label}${extra ? `  ${extra}` : ""}`);
  }
};

// ── 初值树：真卡的 `[initvar]` 形状 ──────────────────────────
console.log("\n--- 初值树（迷你 YAML）---");
const initvar = `世界:
  当前时间: 未知
  当前地点: 未知
  危机程度: 无
  遭遇冷却: 20
  动向: {}
主角:
  姓名: 未知
  境界: 凡人（DC:0）
  生命: 100
  灵力: 100
  修为: 0
  ${"$"}器灵台词: []
  灵根: 未知
  炼丹:
    阶级: 未入门
    熟练度: 0
道侣: {}
`;
const tree = parseInitvar(initvar);
check("顶层键", JSON.stringify(Object.keys(tree)) === JSON.stringify(["世界", "主角", "道侣"]), JSON.stringify(Object.keys(tree)));
check("嵌套数值", tree.世界.遭遇冷却 === 20, String(tree.世界.遭遇冷却));
check("空映射 {} 是对象", typeof tree.世界.动向 === "object" && Object.keys(tree.世界.动向).length === 0);
check("空数组 [] 是数组", Array.isArray(tree.主角["$器灵台词"]));
check("深层嵌套（炼丹.阶级）", tree.主角.炼丹.阶级 === "未入门", JSON.stringify(tree.主角.炼丹));
check("带括号的中文值仍是字符串", tree.主角.境界 === "凡人（DC:0）");
check("布尔与 null", JSON.stringify(parseInitvar("a: true\nb: null\nc: false")) === JSON.stringify({ a: true, b: null, c: false }));
check("行内数组", JSON.stringify(parseInitvar("tags: [甲, 乙, 丙]").tags) === JSON.stringify(["甲", "乙", "丙"]));
let threw = false;
try {
  parseInitvar("a:\n  - 这种东西不该出现");
} catch (error) {
  threw = String(error.message).includes("不支持列表项");
}
check("看不懂的结构明确报错（不半解析）", threw);

// ── 抠块 + 剥正文 ───────────────────────────────────────────
console.log("\n--- 抠出 <UpdateVariable> 并剥掉 ---");
const prose = `灯芯爆了一下。

<UpdateVariable>
<Analysis>时间推进一刻钟；主角灵力-5。</Analysis>
<JSONPatch>
[{"op":"replace","path":"/世界/当前时间","value":"元会历·3726年·12月23日·16点00分"},
 {"op":"delta","path":"/主角/灵力","value":-5}]
</JSONPatch>
</UpdateVariable>

他抬手掐了个诀。`;
const extracted = extractUpdateBlocks(prose);
check("正文里不留变量块", !extracted.body.includes("UpdateVariable"), JSON.stringify(extracted.body.slice(-30)));
check("正文保留正常段落", extracted.body.includes("灯芯爆了一下") && extracted.body.includes("他抬手掐了个诀"));
check("抠出 1 块", extracted.blocks.length === 1);
check("块内保留 Analysis", extracted.blocks[0].includes("时间推进一刻钟"));
const multi = extractUpdateBlocks("<UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>正文<updatevariable><JSONPatch>[{\"op\":\"replace\",\"path\":\"/a\",\"value\":1}]</JSONPatch></updatevariable>");
check("大小写不敏感 + 多块", multi.blocks.length === 2, String(multi.blocks.length));
check("正文只剩「正文」", multi.body === "正文", multi.body);

// ── patch 解析 ──────────────────────────────────────────────
console.log("\n--- patch 解析 ---");
const parsed = parseUpdateBlock(extracted.blocks[0]);
check("解析出 2 条 op", parsed.patch.length === 2, JSON.stringify(parsed.patch.map((o) => o.op)));
check("Analysis 取到", parsed.analysis.includes("灵力-5"));
check("坏 JSON 给出原因而不是抛错", parseUpdateBlock("<JSONPatch>[{oops</JSONPatch>").error?.includes("不是合法 JSON"));
check("没有数组时明确说没有", parseUpdateBlock("<Analysis>x</Analysis>").error?.includes("没有 patch 数组"));
check("数组后面跟了废话也能解析", parseUpdateBlock('<JSONPatch>[{"op":"replace","path":"/a","value":1}] 以上。</JSONPatch>').patch.length === 1);

// ── 应用 patch ──────────────────────────────────────────────
console.log("\n--- 应用 patch（5 种 op + 拒绝口径）---");
const base = parseInitvar(initvar);
const outcome = applyPatch(base, [
  { op: "replace", path: "/世界/当前时间", value: "元会历·3726年·12月23日·16点00分" },
  { op: "delta", path: "/主角/灵力", value: -5 },
  { op: "replace", path: "/主角/储物袋/青锋剑", value: { 数量: 1 } },
  { op: "insert", path: "/主角/宗门", value: "散修" },
]);
check("4 条全部应用", outcome.applied.length === 4, JSON.stringify(outcome.applied));
check("replace 改值", outcome.tree.世界.当前时间.startsWith("元会历"), outcome.tree.世界.当前时间);
check("delta 累加", outcome.tree.主角.生命 === 100 && outcome.tree.主角.灵力 === 95, String(outcome.tree.主角.灵力));
check("不存在的路径 replace → 创建并标记 created", outcome.applied[2].created === true, JSON.stringify(outcome.applied[2]));
check("原树没被改动（不可变）", JSON.stringify(base) === JSON.stringify(parseInitvar(initvar)));

const rejects = applyPatch(base, [
  { op: "delta", path: "/主角/姓名", value: 1 },
  { op: "replace", path: "主角/境界", value: "x" },
  { op: "replace", path: "/_变量", value: 1 },
  { op: "remove", path: "/不存在/的/路径" },
  { op: "frobnicate", path: "/主角/生命", value: 1 },
  { op: "move", path: "/主角/新", from: "/主角/没有这个" },
  { op: "delta", path: "/主角/生命", value: "5" },
]);
check("7 条全被拒（不静默忽略）", rejects.rejected.length === 7, JSON.stringify(rejects.rejected.map((r) => r.reason)));
check("delta 打在字符串上被拒", rejects.rejected[0].reason.includes("已有数字"), rejects.rejected[0].reason);
check("path 缺前导 / 被拒", rejects.rejected[1].reason.includes('必须以 "/" 开头'));
check("_ 开头的只读字段被拒", rejects.rejected[2].reason.includes("只读"));
check("被拒的不动树", JSON.stringify(rejects.tree) === JSON.stringify(base));

const moved = applyPatch(parseInitvar("a:\n  x: 1\nb: {}\n"), [
  { op: "move", path: "/b/x", from: "/a/x" },
  { op: "remove", path: "/a/x" },
]);
check("move 搬移取值", moved.tree.b.x === 1 && moved.tree.a.x === undefined, JSON.stringify(moved.tree));
const arr = applyPatch(parseInitvar("list: []"), [
  { op: "insert", path: "/list/-", value: "甲" },
  { op: "insert", path: "/list/-", value: "乙" },
  { op: "replace", path: "/list/0", value: "丙" },
]);
check("数组 append（-）与按索引改", JSON.stringify(arr.tree.list) === JSON.stringify(["丙", "乙"]), JSON.stringify(arr.tree.list));
const esc = applyPatch(parseInitvar("a:\n  b: 1\n"), [{ op: "replace", path: "/a~1b", value: 2 }]);
check("JSON Pointer 转义（~1 = /）", JSON.stringify(esc.tree) === JSON.stringify({ a: { b: 1 }, "a/b": 2 }), JSON.stringify(esc.tree));

// ── 渲染 ────────────────────────────────────────────────────
console.log("\n--- 渲染成提示词文本 ---");
const rendered = renderState(tree);
check("渲染出「世界.当前时间」", rendered.includes("世界.当前时间: 未知"), rendered.split("\n")[0]);
check("空容器显示成 {} / []", rendered.includes("世界.动向: {}") && rendered.includes("$器灵台词: []"));
check("深层不超过 3 层（炼丹.阶级 打平）", rendered.includes("主角.炼丹.阶级: 未入门"), rendered.slice(0, 200));
const big = renderState({ 大: { 段: "字".repeat(500) } }, 60, 100);
check("超长时截断并说明", big.length <= 160 && big.includes("已省略"), String(big.length));

console.log(`\n${failed === 0 ? "全部通过" : `${String(failed)} 项失败`}：${String(passed + failed)} 项检查`);
process.exit(failed === 0 ? 0 : 1);
