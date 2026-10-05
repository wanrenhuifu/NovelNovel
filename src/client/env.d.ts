/**
 * 客户端半边的类型声明。
 *
 * `react` / `react/jsx-runtime` **不在这里声明**：它们是 devDependencies 里真实安装的类型
 * （TS 的 JSX 检查按 `jsx: react-jsx` 走 react/jsx-runtime 的导出，自己声明一套只会与它冲突）。
 * 本文件只补平台运行时提供、但没有随包发布类型的东西。
 *
 * 值层面的 react / primitives 都由外壳的**静态模块表**提供，不在 bundle 里。
 *
 * 改前必读：`import` 的说明符必须是**精确的平台键**。写
 * `"@deepseek-ai/dsh-client-ui-primitives/client"` 会在运行时抛
 * `missed the module table`（浏览器 console 可见，服务端看不到）。
 *
 * 更狠的一条：**导出的名字必须真实存在**。名字写错时 `tsc` 与本文件都拦不住
 * （声明是我写的），浏览器里会拿到 `undefined` 当组件用，整棵 React 树抛错——
 * 这真的把用户的页面搞崩过一次。权威名单由 `scripts/test-client-primitives.mjs`
 * 对着**安装里的真实产物**校验，那个才是骗不过的那道。
 */
declare module "@deepseek-ai/dsh-client-ui-primitives" {
  import type { ComponentType } from "react";
  /** primitives 的组件不吃具体 props 类型：这里只约束「是个组件」 */
  export const Button: ComponentType<Record<string, unknown>>;
  export const Tag: ComponentType<Record<string, unknown>>;
  export const StateDot: ComponentType<Record<string, unknown>>;
  export const DisclosureRow: ComponentType<Record<string, unknown>>;
  export const MarkdownText: ComponentType<Record<string, unknown>>;
  /** 真实存在的图标（名字已对安装内的产物核对过；错的会在浏览器里把整棵树弄崩） */
  export const IconListPenOutlineRegular: ComponentType<Record<string, unknown>>;
  export const IconFolderOpenRegular: ComponentType<Record<string, unknown>>;
  export const IconDeliverDocRegular: ComponentType<Record<string, unknown>>;
}

declare interface ClientSlotsService {
  /**
   * 等某个 slot 被父条目声明；**不 inject 直接 register 会抛 `is not declared`**。
   * 声明已存在时同步执行，否则在声明者 register 提交后执行。
   */
  inject(key: string, callback: () => () => void): () => void;
  /** 组件是**第二个位置参数**，不是 definition 的字段 */
  register(
    definition: {
      name: string;
      id?: string;
      key?: string;
      order?: number;
      label?: string | (() => string);
      locale?: string;
      inject?: () => Record<string, unknown>;
    },
    component: (props: never) => import("react").ReactNode,
  ): () => void;
}

declare interface ClientContext {
  readonly slots: ClientSlotsService;
  on(event: string, handler: (...args: unknown[]) => void): () => void;
  effect(callback: () => void | (() => void), label?: string): () => void;
}

/**
 * **这里刻意没有 `declare const ctx`。**
 *
 * 曾经有，而那是本次最贵的一个 bug 的成因：它让 `tsc` 对渲染路径里的裸 `ctx` **完全沉默**，
 * 于是 `state.ts` 一个 `useEffect` 里的 `ctx.on("connection/reset", …)` 顺利通过类型检查、
 * 通过 Node 侧测试，然后在浏览器里抛 `ReferenceError: ctx is not defined` ——
 * 整棵 React 树被首方错误边界接走，**面板一片空白**（宿主半边一切正常，极难归因）。
 *
 * 客户端产物是**经典 script**，外壳只注入 `window.__ModuleLoader__` 与 `window.__DSH_BOOT__`，
 * **不提供全局 ctx**。ctx 只能由 `apply(ctx)` 传入，需要跨渲染路径用的能力要显式交出去
 * （见 `state.ts` 的 `attachClientOps`）。
 *
 * 所以：不要把它加回来。没有这条声明，裸 `ctx` 就是编译错误——这才是我们想要的护栏。
 */
