// 预设导入链路测试：SillyTavern 各类预设 JSON 解析 + story_string 渲染 + 提示词组装
// 源码用无扩展相对导入（Vite 风格），Node 直跑 TS 不认，先经 esbuild 打包到临时文件再测真代码
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const outFile = join(mkdtempSync(join(tmpdir(), "nn-preset-")), "bundle.mjs");
await esbuild.build({
  stdin: {
    contents: [
      'export { parsePresetFile } from "./src/domain/presetImport";',
      'export { buildSystemPrompt, renderStoryString, buildContinueUserMessage, trimChatHistory } from "./src/domain/prompt";',
    ].join("\n"),
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: outFile,
});
const {
  parsePresetFile,
  buildSystemPrompt,
  renderStoryString,
  buildContinueUserMessage,
  trimChatHistory,
} = await import(pathToFileURL(outFile).href);

let failed = 0;
function check(label, ok, extra = "") {
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` ${extra}` : ""}`);
}
function throws(label, fn) {
  try {
    fn();
    check(label, false, "（应抛错但未抛）");
  } catch (e) {
    check(label, true, `→ ${e.message}`);
  }
}

// ---- 1. 裸 sysprompt 预设 ----
const sys = parsePresetFile(
  JSON.stringify({ name: "Writer", content: "Write {{char}}'s next reply.", post_history: [] }),
);
check("sysprompt: kind", sys.preset.kind === "system");
check("sysprompt: content 映射到 systemPrompt", sys.preset.systemPrompt === "Write {{char}}'s next reply.");
check("sysprompt: rawData 无损", JSON.parse(sys.preset.rawData).content === "Write {{char}}'s next reply.");

// ---- 2. 裸 context 模板预设（ChatML 风格 story_string） ----
const ctx = parsePresetFile(
  JSON.stringify({
    name: "NovelAI",
    story_string: "{{#if system}}{{system}}\n{{/if}}{{#if description}}{{description}}{{/if}}",
    example_separator: "***",
    chat_start: "***",
    use_stop_strings: true,
  }),
);
check("context: kind", ctx.preset.kind === "context");
check("context: story_string 保留", ctx.preset.storyString.includes("{{description}}"));

// ---- 3. 裸 instruct 预设：仅存档 ----
const instruct = parsePresetFile(
  JSON.stringify({
    name: "ChatML",
    input_sequence: "<|im_start|>user",
    output_sequence: "<|im_start|>assistant",
    stop_sequence: "<|im_end|>",
    wrap: true,
    macro: true,
  }),
);
check("instruct: kind", instruct.preset.kind === "instruct");
check("instruct: 不参与提示词", instruct.preset.systemPrompt === "" && instruct.preset.storyString === "");
check("instruct: 有说明 note", typeof instruct.note === "string" && instruct.note.length > 0);

// ---- 4. 总信封（instruct + context + sysprompt 合订） ----
const envelope = parsePresetFile(
  JSON.stringify({
    instruct: { name: "ChatML", input_sequence: "u", output_sequence: "a" },
    context: { name: "Default-CTX", story_string: "{{system}}\n{{description}}" },
    sysprompt: { name: "Default-SYS", content: "You are a writer." },
    reasoning: { name: "none", prefix: "", suffix: "" },
  }),
);
check("信封: systemPrompt 取自 sysprompt.content", envelope.preset.systemPrompt === "You are a writer.");
check("信封: storyString 取自 context.story_string", envelope.preset.storyString.includes("{{description}}"));
check("信封: 名称取自子预设", envelope.preset.name === "Default-CTX");
check("信封: note 说明忽略部分", (envelope.note ?? "").includes("instruct") && (envelope.note ?? "").includes("reasoning"));

// ---- 5. 拒绝与报错路径 ----
throws("reasoning 预设被拒绝", () =>
  parsePresetFile(JSON.stringify({ name: "think", prefix: "<think>", suffix: "</think>" })),
);
throws("仅 instruct 的信封被拒绝", () =>
  parsePresetFile(JSON.stringify({ instruct: { name: "x", input_sequence: "u", output_sequence: "a" } })),
);
throws("非法 JSON 报错", () => parsePresetFile("{oops"));
throws("无法识别的对象报错", () => parsePresetFile(JSON.stringify({ foo: 1 })));

// ---- 6. renderStoryString：#if / else / trim / 未知变量 ----
const rendered = renderStoryString(
  [
    "{{#if system}}SYS:{{system}}",
    "{{/if}}{{#if missing}}不该出现{{else}}FALLBACK",
    "{{/if}}{{#if empty}}空块{{/if}}",
    "DESC:{{description}} {{trim}} {{unknown_var}}!",
  ].join(""),
  { system: "要求A", description: "描述B", empty: "   ", missing: "" },
);
check("story_string: #if 真值保留", rendered.includes("SYS:要求A"));
check("story_string: #if+else 假值取 else", rendered.includes("FALLBACK") && !rendered.includes("不该出现"));
check("story_string: 空白变量视为假", !rendered.includes("空块"));
check("story_string: 变量替换", rendered.includes("DESC:描述B"));
check("story_string: trim/未知变量被移除", !rendered.includes("{{") && rendered.includes("DESC:描述B"));

// 嵌套 #if：外层为假时整块丢弃，不能残留孤儿 {{/if}} 或内层内容
const nestedFalsy = renderStoryString(
  "{{#if outer}}{{#if inner}}X{{else}}Y{{/if}}{{/if}}END",
  { outer: "", inner: "1" },
);
check("story_string: 嵌套外层为假整块丢弃", nestedFalsy === "END", JSON.stringify(nestedFalsy));
const nestedTruthy = renderStoryString(
  "{{#if outer}}{{#if inner}}X{{else}}Y{{/if}}{{/if}}",
  { outer: "1", inner: "" },
);
check("story_string: 嵌套外层真内层假取内层 else", nestedTruthy === "Y", JSON.stringify(nestedTruthy));

// ---- 7. buildSystemPrompt 接入预设 ----
const project = {
  id: 1,
  title: "长安落雪",
  synopsis: "一句话简介",
  worldbuilding: "唐代长安",
  authorNote: "文笔冷峻克制",
  lorebook: [],
  createdAt: 0,
  updatedAt: 0,
};
const characters = [
  {
    projectId: 1,
    name: "林晚",
    avatar: null,
    avatarType: "",
    specVersion: "v2",
    rawData: "{}",
    description: "{{char}}是冷面刺客。",
    personality: "冷静",
    scenario: "深夜屋顶",
    firstMes: "",
    mesExample: "",
    creatorNotes: "",
    creator: "",
    lorebookCount: 0,
    active: true,
    createdAt: 0,
  },
];

const preset = {
  id: "p1",
  name: "测试预设",
  kind: "context",
  systemPrompt: "你是 {{char}} 的专属写手，为 {{user}} 讲故事。",
  storyString: "{{#if worldbuilding}}## 世界观\n{{worldbuilding}}\n{{/if}}{{description}}\n{{#if system}}## 要求\n{{system}}{{/if}}",
  createdAt: 0,
};
const withPreset = buildSystemPrompt(project, characters, "", preset);
check("预设: {{char}} 宏替换", withPreset.includes("你是 林晚 的专属写手"));
check("预设: {{user}} 宏替换为默认主角", withPreset.includes("为 主角 讲故事"));
check("预设: storyString 渲染世界观", withPreset.includes("## 世界观\n唐代长安"));
check("预设: storyString 渲染角色描述（宏已替换）", withPreset.includes("林晚是冷面刺客。"));
check("预设: system 变量映射写作要求", withPreset.includes("## 要求\n文笔冷峻克制"));
check("预设: 输出规范仍保留", withPreset.includes("## 输出规范"));
check("预设: 默认区块被替换", !withPreset.includes("## 作品简介") && !withPreset.includes("## 主要角色设定"));

const withoutPreset = buildSystemPrompt(project, characters, "", null);
check("无预设: 默认开场白", withoutPreset.includes("正在创作长篇小说《长安落雪》"));
check("无预设: 默认区块齐全", withoutPreset.includes("## 作品简介") && withoutPreset.includes("## 主要角色设定"));

// ---- 8. buildContinueUserMessage：前文章节块 ----
// 哨兵稳定性：ChatPanel 依赖空参输出不变来识别续写消息
check(
  "续写哨兵稳定（空参输出不变）",
  buildContinueUserMessage("", "") === "请直接续写接下来的情节。",
);

const onlyRecent = buildContinueUserMessage("夜色渐深。", "");
check("无前文: 只含当前章节结尾块", onlyRecent.includes("以下是当前章节已有正文的结尾部分") && onlyRecent.includes("夜色渐深。"));
check("无前文: 不含前文引导语", !onlyRecent.includes("前面章节"));

const withPrev = buildContinueUserMessage("夜色渐深。", "", [
  { title: "第一章 雪夜", text: "长安落了大雪。" },
  { title: "第二章 刺客", text: "刀光一闪。" },
]);
check("带前文: 引导语在前", withPrev.indexOf("前面章节的结尾摘录") < withPrev.indexOf("当前章节"));
check("带前文: 章节按由远及近排列", withPrev.indexOf("第一章 雪夜") < withPrev.indexOf("第二章 刺客"));
check("带前文: 摘录内容完整", withPrev.includes("长安落了大雪。") && withPrev.includes("刀光一闪。"));
check("带前文: 当前章节结尾仍在最后", withPrev.lastIndexOf("夜色渐深。") > withPrev.lastIndexOf("刀光一闪。"));

const emptyPrevFiltered = buildContinueUserMessage("正文。", "", [
  { title: "空章", text: "   " },
  { title: "有内容", text: "摘要。" },
]);
check("空内容前文章节被过滤", !emptyPrevFiltered.includes("空章") && emptyPrevFiltered.includes("摘要。"));

const prevNoRecent = buildContinueUserMessage("", "", [{ title: "上一章", text: "结尾。" }]);
check("有前文无当前正文: 仍携带前文", prevNoRecent.includes("结尾。") && prevNoRecent.includes("请直接续写"));

// ---- 9. trimChatHistory：按轮数截断对话 ----
const roles = (list) => list.map((m) => m.role).join(",");
const mkHist = () => [
  { role: "user", content: "u1" },
  { role: "assistant", content: "a1" },
  { role: "user", content: "u2" },
  { role: "assistant", content: "a2" },
  { role: "user", content: "u3" },
  { role: "assistant", content: "a3" },
];

check("maxTurns=0: 全部携带", trimChatHistory(mkHist(), 0).length === 6);
check("maxTurns 为负: 全部携带", trimChatHistory(mkHist(), -1).length === 6);
check("轮数多于历史: 全部携带", trimChatHistory(mkHist(), 99).length === 6);

const t1 = trimChatHistory(mkHist(), 1);
check("maxTurns=1: 只留最后一轮", roles(t1) === "user,assistant" && t1[0].content === "u3");
const t2 = trimChatHistory(mkHist(), 2);
check("maxTurns=2: 留最后两轮", roles(t2) === "user,assistant,user,assistant" && t2[0].content === "u2");

// 末尾是 user（assistant 还在流式中）：截断同样从 user 对齐
const dangling = [...mkHist(), { role: "user", content: "u4" }];
const td = trimChatHistory(dangling, 1);
check("末尾悬空 user: 从该 user 截断", roles(td) === "user" && td[0].content === "u4");

// 连续 assistant（重新生成产生的多条回复）：仍按 user 消息计轮
const multiAssistant = [
  { role: "user", content: "u1" },
  { role: "assistant", content: "a1" },
  { role: "assistant", content: "a1-regen" },
  { role: "user", content: "u2" },
  { role: "assistant", content: "a2" },
];
const tm = trimChatHistory(multiAssistant, 2);
check("多条 assistant: 按 user 计轮", tm[0].content === "u1" && tm.length === 5);

// 开头悬空 assistant（其 user 已被更早的截断切掉）：应随截断丢弃
const orphan = [
  { role: "assistant", content: "orphan" },
  { role: "user", content: "u1" },
  { role: "assistant", content: "a1" },
];
const to = trimChatHistory(orphan, 1);
check("开头悬空 assistant: 被切掉", roles(to) === "user,assistant" && to[0].content === "u1");

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
