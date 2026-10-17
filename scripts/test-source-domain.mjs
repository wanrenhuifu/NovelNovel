// 资料源拆解的纯逻辑测试（设计稿 slice 1）。
//
// 为什么单独测：分类是"自动分类 + 人工纠正"的**第一判据**，判错了不会报错——规则条目会被当设定
// 按关键词随机注入，模型看到的规则就时有时无。用例直接取真实卡《道渊》v5.4.2 的条目名，
// 因为这张卡就是这次改动的起因（356 条混排：设定 / 人物 / 生成规则 / MVU 变量规则）。
import { bundleSource } from "./bundle-source.mjs";

const { module } = await bundleSource(
  "source",
  'export { classifyEntry, classifyEntries, channelCounts, joinRules, joinState, decomposeCard, parseWorldBook, formatImportReport, CHANNEL_LABEL, INJECTABLE_CHANNELS } from "./src/domain/sourceImport";\n',
);
const {
  classifyEntry,
  classifyEntries,
  channelCounts,
  joinRules,
  joinState,
  decomposeCard,
  parseWorldBook,
  formatImportReport,
  CHANNEL_LABEL,
  INJECTABLE_CHANNELS,
} = module;

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

// ── 分类表：用《道渊》真实的条目名 ─────────────────────────────
console.log("\n--- 分类：真实条目名 ---");
const cases = [
  ["[initvar] 初始", "世界:\n  当前时间: 未知", "state"],
  ["变量列表", "世界/主角/储物袋", "state"],
  ["[mvu_update]", "---\n变量更新规则:\n  _强制更新提醒:\n    - 以下变量每次回复必须更新", "gameplay"],
  ["[mvu_update]变量输出格式", "rule:\n  - you must output the update analysis", "gameplay"],
  ["NPC人物生成规则", "生成一个 NPC：姓名/宗门/修为…", "gameplay"],
  ["玄天界宗门生成", "随机生成宗门名与规模", "gameplay"],
  ["秘境/遗迹生成", "按概率表生成秘境层数", "gameplay"],
  ["DC总表", "凡人0｜炼气1~10", "gameplay"],
  ["状态栏", "<data_block>...</data_block>", "material"],
  ["人物详情：林若悠", "玉灵宫圣女，空明幻体。", "cast"],
  ["人物详情：宫银叶", "青云步、冰火双绝体。", "cast"],
  ["灯火之界", "城中每座灯楼守着一道界，灯灭则夜入。", "lore"],
  ["玄天界地理志", "共分九州，以玄天为中心。", "lore"],
];
for (const [name, content, expected] of cases) {
  const got = classifyEntry(name, content);
  check(`「${name}」→ ${CHANNEL_LABEL[expected]}`, got.channel === expected, `实际 ${got.channel}（${got.reason}）`);
}

// 顺序：MVU 规则优先于"人物"（`[mvu_update]` 里也可能写"人物"两个字）
check(
  "顺序：规则优先于人物",
  classifyEntry("[mvu_update]人物更新规则", "人物 好感").channel === "gameplay",
  classifyEntry("[mvu_update]人物更新规则", "人物 好感").channel,
);
check(
  "空内容不参与判定（由调用方丢弃）",
  classifyEntries([{ name: "—— MVU ——", keys: "", content: "", enabled: false }], []).length === 0,
);

// ── 计数 / 拼接 / 报告 ────────────────────────────────────────
console.log("\n--- 计数与拼接 ---");
const entries = classifyEntries(
  [
    { name: "[initvar] 初始", keys: "", content: "主角:\n  境界: 凡人", enabled: false },
    { name: "[mvu_update]", keys: "", content: "每回合更新 世界.当前时间", enabled: true },
    { name: "NPC人物生成规则", keys: "", content: "随机生成 NPC", enabled: false },
    { name: "人物详情：林若悠", keys: "林若悠", content: "玉灵宫圣女。", enabled: true },
    { name: "灯火之界", keys: "", content: "灯灭则夜入。", enabled: true },
    { name: "状态栏", keys: "", content: "<data_block/>", enabled: false },
    { name: "空条目", keys: "", content: "   ", enabled: true },
  ],
  [],
);
check("6 条有效 + 1 条空被丢", entries.length === 6, String(entries.length));
const counts = channelCounts(entries);
check(
  "通道计数",
  counts.state === 1 && counts.gameplay === 2 && counts.cast === 1 && counts.lore === 1 && counts.material === 1,
  JSON.stringify(counts),
);
check("规则区只拼 gameplay", joinRules(entries).includes("世界.当前时间") && !joinRules(entries).includes("灯火之界"));
check("状态初值只拼 state", joinState(entries).includes("境界") && !joinState(entries).includes("data_block"));
check("可注入通道不含 state/material", !INJECTABLE_CHANNELS.includes("state") && !INJECTABLE_CHANNELS.includes("material"));

// ── 拆卡：rawData 里的 alternate_greetings / extensions 摘要 ────
console.log("\n--- 拆卡 ---");
const rawCard = {
  spec: "chara_card_v3",
  data: {
    name: "《道渊》测试",
    description: "封面语",
    first_mes: "开篇剧本",
    alternate_greetings: ["[重塑仙缘]"],
    tags: ["仙侠"],
    system_prompt: "",
    post_history_instructions: "",
    extensions: {
      world: "道渊",
      regex_scripts: [{}, {}, {}],
      tavern_helper: {
        scripts: [
          { name: "MVU", content: "import 'mvu'" },
          { name: "悬浮状态栏", content: "x".repeat(1000) },
        ],
        variables: { phone_data: {} },
      },
    },
  },
};
const decomposed = decomposeCard(
  {
    name: "《道渊》测试",
    specVersion: "v3",
    rawData: JSON.stringify(rawCard),
    description: "封面语",
    personality: "",
    scenario: "",
    firstMes: "开篇剧本",
    creatorNotes: "",
    creator: "",
    lorebookEntriesInCard: 3,
  },
  [
    { name: "[initvar] 初始", keys: "", content: "主角: {}", enabled: false },
    { name: "人物详情：林若悠", keys: "林若悠", content: "玉灵宫圣女。", enabled: true },
    { name: "灯火之界", keys: "", content: "灯灭则夜入。", enabled: true },
  ],
);
check("卡名", decomposed.name === "《道渊》测试");
check("备选开场白从 rawData 里读出来", JSON.stringify(decomposed.meta.alternateGreetings) === JSON.stringify(["[重塑仙缘]"]), JSON.stringify(decomposed.meta.alternateGreetings));
check("tags 从 rawData 里读出来", decompotMetaTagOk(decomposed));
function decompotMetaTagOk(d) {
  return JSON.stringify(d.meta.tags) === JSON.stringify(["仙侠"]);
}
check(
  "extensions 摘要（含正则与脚本，脚本只报名字与字数）",
  decomposed.meta.extensions.some((e) => e.path.startsWith("regex_scripts")) &&
    decomposed.meta.scripts.length === 2 &&
    decomposed.meta.scripts[1].chars === 1000,
  JSON.stringify(decomposed.meta.scripts),
);
check("脚本不执行 → 一定有一条 note 说明", decomposed.notes.some((n) => n.includes("不执行")), JSON.stringify(decomposed.notes));
const report = formatImportReport(decomposed);
check("报告里有通道计数", report[0].includes("状态 1 条") && report[0].includes("角色 1 条"), report[0]);
check(
  "报告里区分'进世界书'与'不进世界书'",
  report.some((line) => line.includes("不进世界书：1 条")),
  report.join(" | "),
);

// ── 独立世界书：两种形状都要认 ─────────────────────────────────
console.log("\n--- 独立世界书 ---");
const stBook = JSON.stringify({
  entries: {
    0: { key: ["长夜", "二十年"], content: "长夜每二十年降临一次。", comment: "长夜纪年" },
    1: { key: [], content: "灯灭则夜入。", comment: "灯火之界" },
    2: { key: ["x"], content: "  ", comment: "空" },
    3: { key: ["y"], content: "被禁用的条目", comment: "禁用", disable: true },
  },
});
const parsedBook = parseWorldBook(stBook);
check("ST World Info 形状：解析出 3 条非空", parsedBook.entries.length === 3, String(parsedBook.entries.length));
check("key 数组 → 逗号分隔的 keys", parsedBook.entries[0].keys === "长夜, 二十年", parsedBook.entries[0].keys);
check("comment 优先作为名字", parsedBook.entries[0].name === "长夜纪年", parsedBook.entries[0].name);
check("disable:true → enabled=false", parsedBook.entries[2].enabled === false);
const plainBook = parseWorldBook(JSON.stringify([{ name: "灯火之界", keys: "", content: "灯灭则夜入。", enabled: true }]));
check("本插件 LoreEntry[] 形状也认", plainBook.entries.length === 1 && plainBook.entries[0].name === "灯火之界");
let threw = false;
try {
  parseWorldBook("{ 不是 JSON");
} catch (error) {
  threw = String(error.message).includes("不是合法 JSON");
}
check("坏 JSON 给出可读错误", threw);
threw = false;
try {
  parseWorldBook(JSON.stringify({ hello: "world" }));
} catch (error) {
  threw = String(error.message).includes("认不出");
}
check("认不出的形状也明确报错", threw);

console.log(`\n${failed === 0 ? "全部通过" : `${String(failed)} 项失败`}：${String(passed + failed)} 项检查`);
process.exit(failed === 0 ? 0 : 1);
