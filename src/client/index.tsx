/**
 * 客户端半边的插件入口。
 *
 * **必须导出一个真正的插件对象**：外壳把我的产物交给 cordis Loader，后者要求
 * 「函数，或带 `apply` 方法的对象」，否则抛
 * `invalid plugin, expect function or object with an "apply" method`。
 * 首方每个客户端产物都是这个形态（`exports.apply = apply`），全 asar 无一例外。
 *
 * 曾经的写法（顶层直接 `ctx.slots.inject(...)`、什么都不导出）有两个致命缺陷，
 * 导致**在真实浏览器里从来没加载成功过一次**：
 * - 外壳从不定义全局 `ctx`：`bootInjections()` 只注入 `window.__ModuleLoader__`
 *   与 `window.__DSH_BOOT__`，`materialize()` 也只把 `require` 传给 factory；
 * - 产物不导出任何东西，Loader 收到空对象直接报错。
 *
 * 所以两条硬约束（改前必读）：
 * - `ctx` 只能由 `apply(ctx)` 传入，**顶层不许引用**；
 * - 必须 `export const inject` 声明依赖的服务（`slots` 由 ui-renderer 提供）。
 */
import type { ReactNode } from "react";
import { IconListPenOutlineRegular } from "@deepseek-ai/dsh-client-ui-primitives";
import { NovelPanel } from "./panel";
import { PanelContext, usePanelStore } from "./state";
import { installStyles } from "./styles";

/** 侧栏条目 id，必须与 main 的 key 一致——这是两者唯一的联系 */
const PANEL_ID = "dsh-novelnovel";
const PANEL_ORDER = 60;

/** 声明的服务：`slots` 是注册插槽的前提 */
export const inject = ["slots"];

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

export function apply(ctx: ClientContext): void {
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
}
