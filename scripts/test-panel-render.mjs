// 面板渲染测试：用 react-dom/server **真渲染** NovelPanel（平台组件库走 shim，面板代码是真的）。
//
// 覆盖什么：JSX 层面的崩溃、宿主数据形状不对时的崩溃、以及"某块 UI 该出现却没出现"。
// 覆盖不到什么：CSS 与交互（点击/键盘的真实事件、布局、主题 token 的实际渲染）——那些要浏览器。
//
// 为什么值得：面板从没在浏览器里跑过，而它两次让整个前端崩掉（一次是引用了不存在的组件名，
// 一次是整个半边加载不上）。渲染测试是**在没有浏览器的情况下**能拿到的最强信号。
import { fileURLToPath, pathToFileURL } from "node:url";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildPanelForRender } from "../tests/panel-render-helper.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const outfile = await buildPanelForRender(repo);
// Windows 的绝对路径要转成 file:// URL 才能 import
const { NovelPanel, PanelContext, INITIAL } = await import(pathToFileURL(outfile).href);

let passed = 0;
let failed = 0;
const check = (label, ok, extra = "") => {
  if (ok) {
    passed++;
    console.log(`✓ ${label}${extra ? `  ${extra}` : ""}`);
  } else {
    failed++;
    console.log(`✗ ${label}${extra ? `  ${extra}` : ""}`);
  }
};

/** 渲染一次面板；返回 HTML 或 `{ error }` */
function render(stateOverrides) {
  const state = { ...INITIAL, ...stateOverrides };
  try {
    const html = renderToStaticMarkup(
      React.createElement(
        PanelContext.Provider,
        {
          value: {
            state,
            actions: { refresh: () => undefined, selectProject: () => undefined, selectChapter: () => undefined },
          },
        },
        React.createElement(NovelPanel),
      ),
    );
    return { html };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
}

const project = (over) => ({
  id: "p1",
  title: "夜行者",
  chapters: 2,
  words: 12345,
  active: true,
  updatedAt: 0,
  ...over,
});
const chapterSummary = (over) => ({
  id: "c1",
  title: "第一章 灯下",
  tags: ["伏笔"],
  words: 3200,
  updatedAt: 0,
  ...over,
});
const detail = (over) => ({
  project: { id: "p1", title: "夜行者", synopsis: "简介", updatedAt: 0 },
  chapters: [chapterSummary()],
  characters: [
    { id: "k1", name: "林晚", active: true, specVersion: "v2", hasAvatar: true, description: "刺客" },
  ],
  lorebook: [{ id: "l1", name: "设定", keys: "血月", enabled: true }],
  ...over,
});

console.log("--- 加载中（骨架）---");
{
  const out = render({ loading: true, projects: [project({})], activeId: "p1" });
  check("加载态能渲染（不崩）", out.error === undefined, out.error ?? "");
  check("加载态显示骨架", out.html?.includes("nnv-skeleton") === true || out.html?.includes("nnv-") === true);
}

console.log("--- 正常数据 ---");
{
  const out = render({
    loading: false,
    projects: [project({})],
    activeId: "p1",
    detail: detail({}),
    chapter: { id: "c1", title: "第一章 灯下", tags: ["伏笔"], words: 3200, content: "雨下了一整夜。", updatedAt: 0 },
    chapterId: "c1",
  });
  check("完整数据能渲染", out.error === undefined, out.error ?? "");
  check("顶栏显示作品名", out.html?.includes("夜行者") === true);
  check("顶栏显示章节数与字数", out.html?.includes("2 章") === true && out.html?.includes("万字") === true);
  check("左栏列出章节", out.html?.includes("第一章 灯下") === true);
  check("正文渲染出来", out.html?.includes("雨下了一整夜") === true);
  check("章节标签渲染成 Tag 组件", out.html?.includes('data-prim="tag"') === true);
  check("刷新按钮渲染（且用 sm 尺寸）", out.html?.includes('data-prim="button"') === true && out.html?.includes('data-size="sm"') === true);
  check("侧栏图标渲染", out.html?.includes('data-prim="icon"') === true);
  check("参与角色被列出", out.html?.includes("林晚") === true);
}

console.log("--- 空态：一个作品都没有 ---");
{
  const out = render({ loading: false, projects: [], activeId: null, detail: null });
  check("空态能渲染", out.error === undefined, out.error ?? "");
  check("空态给出可执行的下一步", out.html?.includes("novel_project") === true || out.html?.includes("还没有作品") === true);
}

console.log("--- 多作品时出现切换器 ---");
{
  const out = render({
    loading: false,
    projects: [project({}), project({ id: "p2", title: "第二部", active: false })],
    activeId: "p1",
    detail: detail({}),
    chapterId: null,
  });
  check("多作品能渲染", out.error === undefined, out.error ?? "");
  check("出现项目切换器（select）", out.html?.includes("<select") === true);
  check("两个作品都在选项里", out.html?.includes("第二部") === true);
}

console.log("--- 错误与不可读作品要点名 ---");
{
  const out = render({
    loading: false,
    projects: [project({})],
    activeId: "p1",
    error: "request failed with 400",
    unreadable: [{ id: "broken-novel", error: "project.json is not valid JSON" }],
  });
  check("错误态能渲染", out.error === undefined, out.error ?? "");
  check("显示错误文案", out.html?.includes("request failed with 400") === true);
  check(
    "点名读不出来的作品（而不是静默隐藏）",
    out.html?.includes("broken-novel") === true,
    out.html?.includes("project.json is not valid JSON") ? "" : "缺少原因",
  );
}

console.log("--- 宿主持久化数据缺字段时不能崩 ---");
// 这些形状正是"人手改坏了 JSON"会产生的：normalize 会兜住大部分，但面板自己也该扛得住
{
  const broken = [
    ["chapters 是 null", { detail: detail({ chapters: null }) }],
    ["chapters 元素缺字段", { detail: detail({ chapters: [{ id: "c1" }] }) }],
    ["tags 不是数组", { detail: detail({ chapters: [chapterSummary({ tags: "不是数组" })] }) }],
    ["lorebook 是 null", { detail: detail({ lorebook: null }) }],
    ["characters 是 null", { detail: detail({ characters: null }) }],
    ["project 缺 title", { detail: detail({ project: { id: "p1" } }) }],
    ["chapter.content 是数字", { chapter: { id: "c1", title: "t", tags: [], words: 0, content: 42, updatedAt: 0 } }],
    ["chapter.tags 是 null", { chapter: { id: "c1", title: "t", tags: null, words: 0, content: "x", updatedAt: 0 } }],
  ];
  for (const [label, overrides] of broken) {
    const out = render({
      loading: false,
      projects: [project({})],
      activeId: "p1",
      detail: detail({}),
      chapterId: "c1",
      ...overrides,
    });
    check(`${label} → 不崩`, out.error === undefined, out.error ?? "");
  }
}

console.log(`\n${failed === 0 ? "全部通过" : `${String(failed)} 项失败`}：${String(passed + failed)} 项检查`);
process.exit(failed === 0 ? 0 : 1);
