/**
 * 客户端半边入口。
 *
 * 这个文件产出的 `lib/client.js` **不是 ESM，也不是 Node CJS 模块**：
 * 它是一段经典 `<script>`，内容是 `window.__ModuleLoader__.load({ id, factory })`，
 * `factory(require) => module.exports`。格式由 build.client.mjs 包装，别手改产物。
 *
 * 挂载点：
 * - `sidebar.panellist`（list）：左侧栏的图标入口，`id` 同时是 `main` 的派发 key；
 * - `main`（keyed）：中央面板本体，按侧栏选中的 id 派发。
 *
 * 两条硬约束（改前必读）：
 * - 组件是 `ctx.slots.register(definition, Component)` 的**第二个位置参数**；
 * - 必须先 `ctx.slots.inject(key, …)`——slot 由父条目声明，凭空 register 会抛 `is not declared`。
 */
import type { ReactNode } from "react";
import { IconListPenOutlineRegular } from "@deepseek-ai/dsh-client-ui-primitives";
import { NovelPanel } from "./panel";
import { PanelContext, usePanelStore } from "./state";
import { installStyles } from "./styles";

/** 侧栏条目 id，必须与 main 的 key 一致——这是两者唯一的联系 */
const PANEL_ID = "dsh-novelnovel";
const PANEL_ORDER = 60;

/** 侧栏图标：只负责渲染，点击与展开由 sidebar 的首方实现接管 */
function NovelIcon(): ReactNode {
  return <IconListPenOutlineRegular size={16} />;
}

/** 把 store 与 Context 一起挂到面板上；store 只在这一层创建 */
function NovelPanelRoot(): ReactNode {
  const store = usePanelStore();
  return (
    <PanelContext.Provider value={store}>
      <NovelPanel />
    </PanelContext.Provider>
  );
}

installStyles();

ctx.slots.inject("sidebar.panellist", () =>
  ctx.slots.register(
    {
      name: "sidebar.panellist",
      id: PANEL_ID,
      order: PANEL_ORDER,
      label: "NovelNovel",
    },
    NovelIcon,
  ),
);

ctx.slots.inject("main", () =>
  ctx.slots.register(
    {
      name: "main",
      key: PANEL_ID,
    },
    NovelPanelRoot,
  ),
);
