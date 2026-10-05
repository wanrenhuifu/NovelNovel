// 面板**交互层**测试：用 jsdom + react-dom/client 真挂载，触发真实点击与键盘事件。
//
// 与 `test:render` 的分工：渲染测试用 react-dom/server（拿不到事件），这里用真 DOM 挂载，
// 所以能验证**事件接线**——点击章节行是否调回调、键盘是否按修过的 off-by-one 跳章、
// 输入框里的按键是否被放行、焦点在面板外时是否不响应。
//
// 平台组件库仍走 shim（见 panel-render-helper），面板代码是真的。
import { JSDOM } from "jsdom";
import { fileURLToPath, pathToFileURL } from "node:url";

// ── 先立好 DOM：React 的 client 入口在 import 时就会碰全局 ──────────
const dom = new JSDOM("<!doctype html><html><body><div id=\"outside\"><input id=\"other-input\"></div></body></html>", {
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// Node 24 里 `navigator` 是只读全局（有 getter 没 setter），直接赋值会抛
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.Event = dom.window.Event;
globalThis.KeyboardEvent = dom.window.KeyboardEvent;
globalThis.MouseEvent = dom.window.MouseEvent;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");

const { buildPanelForRender } = await import("../tests/panel-render-helper.mjs");
const repo = fileURLToPath(new URL("..", import.meta.url));
const outfile = await buildPanelForRender(repo);
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

const chapterSummary = (over) => ({
  id: "c1",
  title: "第一章 灯下",
  tags: ["伏笔"],
  words: 3200,
  updatedAt: 0,
  ...over,
});

/**
 * 挂载面板，返回 { container, calls, unmount }。
 *
 * **harness 会记住 `selectChapter` 的结果并重渲染**——真实应用里 `state.ts` 就是这么做的
 * （选中项一变，下一次渲染的 `chapterId` 就变了）。不这么做的话，连按两次方向键会都从初始
 * 章节算起，测出来的"行为"是假象（我第一版就是这样，看起来像 off-by-one 又犯了）。
 */
async function mount(stateOverrides) {
  const calls = { selectChapter: [], selectProject: [], refresh: 0 };
  const container = document.createElement("div");
  document.body.appendChild(container);
  let state = { ...INITIAL, ...stateOverrides };
  const root = createRoot(container);

  const render = async () => {
    await act(async () => {
      root.render(
        React.createElement(
          PanelContext.Provider,
          {
            value: {
              state,
              actions: {
                refresh: () => {
                  calls.refresh += 1;
                },
                selectProject: (id) => {
                  calls.selectProject.push(id);
                },
                selectChapter: (id) => {
                  calls.selectChapter.push(id);
                  state = { ...state, chapterId: id, chapter: { id, title: id, tags: [], words: 0, content: "", updatedAt: 0 } };
                  void render();
                },
              },
            },
          },
          React.createElement(NovelPanel),
        ),
      );
    });
  };
  await render();
  return { container, calls, unmount: () => act(() => root.unmount()) };
}

/** 派发一次按键到指定元素（默认面板根） */
async function press(target, key, init = {}) {
  await act(async () => {
    target.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });
}

async function click(target) {
  await act(async () => {
    target.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

const baseDetail = {
  project: { id: "p1", title: "夜行者", synopsis: "", updatedAt: 0 },
  chapters: [chapterSummary({ id: "c1", title: "第一章" }), chapterSummary({ id: "c2", title: "第二章" }), chapterSummary({ id: "c3", title: "第三章" })],
  characters: [],
  lorebook: [],
};
const baseState = {
  loading: false,
  projects: [{ id: "p1", title: "夜行者", chapters: 3, words: 9000, active: true, updatedAt: 0 }],
  activeId: "p1",
  detail: baseDetail,
  chapterId: "c2",
  chapter: { id: "c2", title: "第二章", tags: [], words: 3000, content: "正文" },
};

// ── 点击章节行 ─────────────────────────────────────────────────────
console.log("--- 点击章节行 ---");
{
  const { container, calls, unmount } = await mount(baseState);
  const rows = container.querySelectorAll(".nnv-row");
  check("左栏渲染出全部章节行", rows.length === 3, `rows=${String(rows.length)}`);
  check(
    "选中的那一行带 data-selected",
    container.querySelector('.nnv-row[data-selected="true"]')?.textContent?.includes("第二章") === true,
    container.querySelector('.nnv-row[data-selected="true"]')?.textContent ?? "(无)",
  );
  await click(rows[0]);
  check("点第一行 → selectChapter(c1)", calls.selectChapter.includes("c1"), JSON.stringify(calls.selectChapter));
  await click(rows[2]);
  check("点第三行 → selectChapter(c3)", calls.selectChapter.includes("c3"), JSON.stringify(calls.selectChapter));
  await unmount();
}

// ── 刷新按钮 ───────────────────────────────────────────────────────
console.log("--- 刷新按钮 ---");
{
  const { container, calls, unmount } = await mount(baseState);
  const button = [...container.querySelectorAll("button")][0];
  check("找到刷新按钮", button !== undefined, button?.textContent ?? "");
  if (button) await click(button);
  check("点击触发 refresh", calls.refresh === 1, `refresh=${String(calls.refresh)}`);
  await unmount();
}

// ── 键盘：必须是修过的 off-by-one 行为 ─────────────────────────────
console.log("--- 键盘导航（含未选中时的 off-by-one）---");
{
  const { container, calls, unmount } = await mount(baseState);
  const root = container.querySelector(".nnv-root");
  check("面板根存在", root !== null);
  calls.selectChapter.length = 0;

  await press(root, "ArrowDown");
  check("选中第二章按 ↓ → c3", calls.selectChapter.at(-1) === "c3", JSON.stringify(calls.selectChapter));
  await press(root, "ArrowUp");
  check("再按 ↑ → c2", calls.selectChapter.at(-1) === "c2", JSON.stringify(calls.selectChapter));
  await press(root, "j");
  check("j 等同 ↓ → c3", calls.selectChapter.at(-1) === "c3", JSON.stringify(calls.selectChapter));
  await press(root, "k");
  check("k 等同 ↑ → c2", calls.selectChapter.at(-1) === "c2", JSON.stringify(calls.selectChapter));
  await press(root, "Home");
  check("Home 不被处理（不抢别处的既定含义）", calls.selectChapter.at(-1) === "c2", JSON.stringify(calls.selectChapter));
  await unmount();
}
{
  // 未选中：第一版实现会跳到第 2 章，第 1 章永远按不到
  const { container, calls, unmount } = await mount({ ...baseState, chapterId: null, chapter: null });
  const root = container.querySelector(".nnv-root");
  calls.selectChapter.length = 0;
  await press(root, "ArrowDown");
  check(
    "未选中时按 ↓ → 第 1 章（不是第 2 章）",
    calls.selectChapter.at(-1) === "c1",
    JSON.stringify(calls.selectChapter),
  );
  await unmount();
}

// ── 键盘：不该响应的情况 ───────────────────────────────────────────
console.log("--- 键盘不该响应的情况 ---");
{
  const { container, calls, unmount } = await mount(baseState);
  const root = container.querySelector(".nnv-root");
  calls.selectChapter.length = 0;

  // 焦点在面板**外**的输入框：不该抢键
  const outsideInput = document.getElementById("other-input");
  await press(outsideInput, "ArrowDown");
  check("焦点在面板外时按 ↓ 不响应", calls.selectChapter.length === 0, JSON.stringify(calls.selectChapter));

  // 面板**内**的输入框（多作品时会出现 select；用 select 验证表单元素豁免）
  await unmount();
}
{
  // 多作品 → 出现 <select>；在它上面按方向键不该被面板抢走
  const { container, calls, unmount } = await mount({
    ...baseState,
    projects: [
      { id: "p1", title: "夜行者", chapters: 3, words: 9000, active: true, updatedAt: 0 },
      { id: "p2", title: "第二部", chapters: 1, words: 100, active: false, updatedAt: 0 },
    ],
  });
  const select = container.querySelector("select");
  check("多作品时出现切换器", select !== null);
  calls.selectChapter.length = 0;
  if (select) await press(select, "ArrowDown");
  check("在 select 上按 ↓ 不切换章节（表单元素豁免）", calls.selectChapter.length === 0, JSON.stringify(calls.selectChapter));
  await unmount();
}

console.log(`\n${failed === 0 ? "全部通过" : `${String(failed)} 项失败`}：${String(passed + failed)} 项检查`);
process.exit(failed === 0 ? 0 : 1);
