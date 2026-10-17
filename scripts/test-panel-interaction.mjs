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
  review: null,
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
  const calls = {
    selectChapter: [],
    selectProject: [],
    refresh: 0,
    saveChapter: [],
    createChapter: [],
    renameChapter: [],
    deleteChapter: [],
    moveChapter: [],
    setTargetWords: [],
    importCharacter: [],
    setCharacterActive: [],
    deleteCharacter: [],
  };
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
                  state = {
                    ...state,
                    chapterId: id,
                    chapter: { id, title: id, tags: [], words: 0, content: "", updatedAt: 0, goal: "", review: null },
                  };
                  void render();
                },
                // 写操作在面板里是"先请求后重取"，这里只记下调用与参数——
                // 重取由 state.ts 负责，交互测试要验的是**接线**（点了有没有调、传的是什么）
                saveChapter: (content) => {
                  calls.saveChapter.push(content);
                },
                createChapter: (title) => {
                  calls.createChapter.push(title);
                },
                renameChapter: (id, title) => {
                  calls.renameChapter.push([id, title]);
                },
                deleteChapter: (id) => {
                  calls.deleteChapter.push(id);
                },
                moveChapter: (id, direction) => {
                  calls.moveChapter.push([id, direction]);
                },
                setTargetWords: (words) => {
                  calls.setTargetWords.push(words);
                },
                importCharacter: (file) => {
                  calls.importCharacter.push(file);
                },
                setCharacterActive: (id, active) => {
                  calls.setCharacterActive.push([id, active]);
                },
                deleteCharacter: (id) => {
                  calls.deleteCharacter.push(id);
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

/** 按可见文字找按钮：比 `querySelectorAll("button")[0]` 稳（新增一个按钮就会错位） */
function buttonByText(container, text) {
  return [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === text);
}

async function change(target, value) {
  await act(async () => {
    // **必须走原型上的 setter**：直接 `target.value = x` 会同时更新 React 挂在节点上的
    // value tracker，React 认为"值没变"从而不调 onChange——测出来的会是假失败
    const proto =
      target.tagName === "TEXTAREA"
        ? dom.window.HTMLTextAreaElement.prototype
        : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(target, value);
    target.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
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
  project: { id: "p1", title: "夜行者", synopsis: "", updatedAt: 0, targetWords: null },
  chapters: [chapterSummary({ id: "c1", title: "第一章" }), chapterSummary({ id: "c2", title: "第二章" }), chapterSummary({ id: "c3", title: "第三章" })],
  characters: [],
  lorebook: [],
};
const baseState = {
  loading: false,
  projects: [{ id: "p1", title: "夜行者", chapters: 3, words: 9000, targetWords: null, active: true, updatedAt: 0 }],
  activeId: "p1",
  detail: baseDetail,
  chapterId: "c2",
  chapter: { id: "c2", title: "第二章", tags: [], words: 3000, content: "正文", updatedAt: 0, goal: "", review: null },
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
  const button = buttonByText(container, "刷新");
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

// ── 写操作：章节的增 / 改 / 删 / 排序 ───────────────────────────────
console.log("--- 章节写操作 ---");
{
  const { container, calls, unmount } = await mount(baseState);
  await click(buttonByText(container, "＋ 新建"));
  const input = container.querySelector(".nnv-form .nnv-input");
  check("点「＋ 新建」出现输入框", input !== null);
  if (input) await change(input, "第四章 祭坛");
  await click(buttonByText(container, "新建"));
  check(
    "提交后调用 createChapter(title)",
    calls.createChapter[0] === "第四章 祭坛",
    JSON.stringify(calls.createChapter),
  );
  await unmount();
}
{
  const { container, calls, unmount } = await mount(baseState);
  const row = container.querySelectorAll(".nnv-row")[0];
  const rename = [...row.querySelectorAll("button")].find((b) => b.textContent === "✎");
  check("章节行有改名按钮", rename !== undefined);
  if (rename) await click(rename);
  const input = container.querySelector(".nnv-form .nnv-input");
  if (input) await change(input, "第一章 改名后");
  await click(buttonByText(container, "改名"));
  check(
    "改名调用 renameChapter(id, title)",
    JSON.stringify(calls.renameChapter[0]) === JSON.stringify(["c1", "第一章 改名后"]),
    JSON.stringify(calls.renameChapter),
  );
  await unmount();
}
{
  const { container, calls, unmount } = await mount(baseState);
  const row = container.querySelectorAll(".nnv-row")[0];
  const remove = [...row.querySelectorAll("button")].find((b) => b.textContent === "✕");
  check("章节行有删除按钮", remove !== undefined);
  if (remove) await click(remove);
  check("第一次点 ✕ 只进入确认态，不删", calls.deleteChapter.length === 0, JSON.stringify(calls.deleteChapter));
  await click(buttonByText(container, "确认删除"));
  check("点了「确认删除」才真的删", calls.deleteChapter[0] === "c1", JSON.stringify(calls.deleteChapter));
  await unmount();
}
{
  const { container, calls, unmount } = await mount(baseState);
  const rows = container.querySelectorAll(".nnv-row");
  const up = [...rows[0].querySelectorAll("button")].find((b) => b.textContent === "↑");
  const down = [...rows[0].querySelectorAll("button")].find((b) => b.textContent === "↓");
  check("第一章的 ↑ 是禁用的（已经在头）", up?.disabled === true);
  if (down) await click(down);
  check(
    "点 ↓ 调用 moveChapter(id, down)",
    JSON.stringify(calls.moveChapter[0]) === JSON.stringify(["c1", "down"]),
    JSON.stringify(calls.moveChapter),
  );
  await unmount();
}

// ── 写操作：正文编辑与保存基准 ─────────────────────────────────────
console.log("--- 正文编辑 ---");
{
  const { container, calls, unmount } = await mount(baseState);
  check("默认是阅读态（没有 textarea）", container.querySelector(".nnv-textarea") === null);
  await click(buttonByText(container, "编辑正文"));
  const textarea = container.querySelector(".nnv-textarea");
  check("进入编辑态出现 textarea", textarea !== null);
  check("textarea 里是当前正文", textarea?.value === "正文", textarea?.value ?? "(无)");
  // 没改动时点保存**什么都不该发生**（`disabled` 在面板的组件库 shim 上会被丢掉，
  // 所以这里验的是处理函数里的守卫——那才是换实现后仍然成立的那一道）
  await click(buttonByText(container, "保存"));
  check("没改动时点保存不发出写请求", calls.saveChapter.length === 0, JSON.stringify(calls.saveChapter));
  if (textarea) await change(textarea, "改过的正文");
  await click(buttonByText(container, "保存"));
  check(
    "保存把**草稿全文**交给 saveChapter",
    calls.saveChapter[0] === "改过的正文",
    JSON.stringify(calls.saveChapter),
  );
  await click(buttonByText(container, "重新加载"));
  check("「重新加载」触发 refresh（冲突后拿回最新正文的路）", calls.refresh >= 1, `refresh=${String(calls.refresh)}`);
  await unmount();
}

// ── 写操作：角色卡（导入 / 参与开关 / 删除）与目标字数 ─────────────
console.log("--- 角色卡与目标字数 ---");
{
  const detail = {
    ...baseDetail,
    characters: [
      { id: "ch1", name: "林晚", active: true, specVersion: "v2", hasAvatar: false, description: "守夜人" },
    ],
  };
  const { container, calls, unmount } = await mount({ ...baseState, detail });

  const toggle = container.querySelector(".nnv-toggle");
  check("角色卡有参与开关", toggle !== null);
  if (toggle) await click(toggle);
  check(
    "取消参与 → setCharacterActive(id, false)",
    JSON.stringify(calls.setCharacterActive[0]) === JSON.stringify(["ch1", false]),
    JSON.stringify(calls.setCharacterActive),
  );

  const fileInput = container.querySelector('input[type="file"]');
  check("有（隐藏的）文件选择框", fileInput !== null);
  if (fileInput) {
    const file = new dom.window.File([new Uint8Array([137, 80, 78, 71])], "卡.png", { type: "image/png" });
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
    await act(async () => {
      fileInput.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
  }
  check(
    "选中文件后调用 importCharacter(file)",
    calls.importCharacter.length === 1 && calls.importCharacter[0].name === "卡.png",
    String(calls.importCharacter.length),
  );

  const remove = [...container.querySelectorAll(".nnv-row-char button")].find((b) => b.textContent === "✕");
  if (remove) await click(remove);
  check("删卡也要二次确认（第一次不删）", calls.deleteCharacter.length === 0);
  await click(buttonByText(container, "确认删除"));
  check("确认后调用 deleteCharacter(id)", calls.deleteCharacter[0] === "ch1", JSON.stringify(calls.deleteCharacter));
  await unmount();
}
{
  // 没设目标：入口写着"设目标字数"；设了之后显示百分比
  const { container, calls, unmount } = await mount(baseState);
  const entry = container.querySelector(".nnv-target");
  check("顶栏有目标字数入口", entry !== null, entry?.textContent ?? "");
  check("没设目标时显示「设目标字数」", entry?.textContent === "设目标字数", entry?.textContent ?? "");
  if (entry) await click(entry);
  const number = container.querySelector('.nnv-input[type="number"]');
  check("点开后出现数字输入框", number !== null);
  if (number) await change(number, "120000");
  await click(buttonByText(container, "确定"));
  check("提交后调用 setTargetWords(120000)", calls.setTargetWords[0] === 120000, JSON.stringify(calls.setTargetWords));
  await unmount();
}
{
  const detail = { ...baseDetail, project: { ...baseDetail.project, targetWords: 100000 } };
  const projects = [{ id: "p1", title: "夜行者", chapters: 3, words: 36000, targetWords: 100000, active: true, updatedAt: 0 }];
  const { container, unmount } = await mount({ ...baseState, detail, projects });
  const entry = container.querySelector(".nnv-target");
  check(
    "设了目标就显示已写/目标的百分比",
    entry?.textContent === "目标 10.0 万字（36%）",
    entry?.textContent ?? "(无)",
  );
  await unmount();
}

console.log(`\n${failed === 0 ? "全部通过" : `${String(failed)} 项失败`}：${String(passed + failed)} 项检查`);
process.exit(failed === 0 ? 0 : 1);
