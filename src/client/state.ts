/**
 * 面板状态：一次取数 + 选择态。
 *
 * 刷新策略遵循官方形态（不自己造推送通道）：
 * - 挂载时取一次；
 * - 订阅 `connection/reset`（重连后一律失效）重取；
 * - 模型调用 `novel_*` 工具后由会话事件触发一次轻量重取（见 index.tsx）。
 *
 * 取数只有一条路径（`load`），选择只有两个入口；请求带版本号，慢响应不得覆盖新选择。
 */
import * as React from "react";
import { ApiFailure, api, type ChapterDetail, type ProjectDetail, type ProjectSummary } from "./api";
import { normalizeChapter, normalizeDetail } from "./normalize";

export interface PanelState {
  loading: boolean;
  chapterLoading: boolean;
  /** 有写请求在飞：按钮禁用、显示"保存中…" */
  busy: boolean;
  error: string | null;
  /** 上一次操作的结果（成功也报，不然用户不知道点了有没有用） */
  notice: string | null;
  projects: ProjectSummary[];
  unreadable: { id: string; error: string }[];
  activeId: string | null;
  detail: ProjectDetail | null;
  chapter: ChapterDetail["chapter"] | null;
  /** 当前选中章节的 id：键盘导航按它定位，不去 DOM 里反查 */
  chapterId: string | null;
}

/**
 * 面板能做的事。写操作全部**先请求后重取**（不做乐观更新）：
 * 面板改的是模型正在写的同一份稿子，本地先改再对齐，一旦冲突就会出现"屏幕上是对的一版、
 * 磁盘上是另一版"的状态——那是这个面板最不该有的东西。代价是一次多余的网络往返。
 */
export interface PanelActions {
  refresh(): void;
  selectProject(id: string): void;
  selectChapter(id: string): void;
  /** 保存当前章节正文（`content` 是编辑器里的全文） */
  saveChapter(content: string): void;
  createChapter(title: string): void;
  renameChapter(id: string, title: string): void;
  /** 删除章节；确认对话框在面板侧，点了才会调到这里 */
  deleteChapter(id: string): void;
  moveChapter(id: string, direction: "up" | "down"): void;
  /** 全书目标字数；`null` = 清掉目标 */
  setTargetWords(words: number | null): void;
  /** 从本机选一个 PNG/JSON 角色卡导入（走上传，不经过文件工具） */
  importCharacter(file: File): void;
  setCharacterActive(id: string, active: boolean): void;
  deleteCharacter(id: string): void;
}

const NO_ACTIONS: PanelActions = {
  refresh: () => undefined,
  selectProject: () => undefined,
  selectChapter: () => undefined,
  saveChapter: () => undefined,
  createChapter: () => undefined,
  renameChapter: () => undefined,
  deleteChapter: () => undefined,
  moveChapter: () => undefined,
  setTargetWords: () => undefined,
  importCharacter: () => undefined,
  setCharacterActive: () => undefined,
  deleteCharacter: () => undefined,
};

/**
 * 初始状态：**状态的单一真相**。
 * 导出它是为了让渲染测试能用同一份形状构造夹具——手抄一份字段列表迟早会与这里漂移。
 */
export const INITIAL: PanelState = {
  loading: true,
  chapterLoading: false,
  busy: false,
  error: null,
  notice: null,
  projects: [],
  unreadable: [],
  activeId: null,
  detail: null,
  chapter: null,
  chapterId: null,
};

export const PanelContext = React.createContext<{ state: PanelState; actions: PanelActions }>({
  state: INITIAL,
  actions: NO_ACTIONS,
});

export function usePanel(): { state: PanelState; actions: PanelActions } {
  return React.useContext<{ state: PanelState; actions: PanelActions }>(PanelContext);
}

/** 渲染路径需要的那部分客户端上下文（只有 `on`，不持有整个 ctx） */
export interface ClientOps {
  on(event: "connection/reset", listener: () => void): () => void;
}

/**
 * 客户端半边的事件上下文：由 `apply(ctx)` 交进来（`attachClientOps`）。
 *
 * **为什么要有这个模块级变量**：客户端产物是浏览器里的经典 script，外壳**不提供全局 `ctx`**
 * （只注入 `window.__ModuleLoader__` 与 `window.__DSH_BOOT__`）。所以渲染路径里任何裸 `ctx` 都会在
 * 浏览器里抛 `ReferenceError: ctx is not defined`，被首方错误边界接走 → **面板一片空白**。
 * 实测踩过：`ctx.on("connection/reset")` 写在一个 `useEffect` 里，静态检查与 Node 侧测试都发现不了
 * （Node 的模块作用域里恰好没有 `ctx`，也不报错）。现在由 `npm run test:bundle-runs` 守着。
 */
let clientOps: ClientOps | undefined;

/** `apply(ctx)` 调用一次，把渲染路径需要的能力存下来 */
export function attachClientOps(ops: ClientOps): void {
  clientOps = ops;
}

export function usePanelStore(): { state: PanelState; actions: PanelActions } {
  const [state, setState] = React.useState<PanelState>(INITIAL);
  /** 整份取数（作品→详情→首章）的版本号 */
  const version = React.useRef(0);
  /** 单独切章请求的版本号，与 `version` 分开：两者互不取消对方 */
  const chapterVersion = React.useRef(0);
  /**
   * 当前作品 id 的「最新值」。
   * 事件处理器（点章节、键盘）必须读它而不是渲染闭包里的 state——
   * 切作品是「立刻改 id + 异步取详情」，闭包里的值会滞后。见 selectChapter。
   */
  const activeIdRef = React.useRef<string | null>(null);
  /** 同理：写操作之后要"停在当前这一章"重取，闭包里的 chapterId 可能已经过期 */
  const chapterIdRef = React.useRef<string | null>(null);
  /**
   * **加载进来时的那份正文**：保存时作为"我基于哪一版改的"比对基准交给宿主。
   * 必须是它而不是编辑器里的草稿——草稿是"我要写成什么"，基准是"我看到的是什么"。
   */
  const loadedContentRef = React.useRef<string | null>(null);
  /** 刚新建的章节 id：重取时要选中它（不然点了"新建"却看不到在编辑什么） */
  const createdChapterRef = React.useRef<string | null>(null);

  const patch = React.useCallback((next: Partial<PanelState>) => {
    if (next.activeId !== undefined) activeIdRef.current = next.activeId;
    if (next.chapterId !== undefined) chapterIdRef.current = next.chapterId;
    if (next.chapter !== undefined) loadedContentRef.current = next.chapter?.content ?? null;
    setState((prev) => ({ ...prev, ...next }));
  }, []);

  /** 唯一的取数入口：列作品 → 选当前作品 → 取详情 → 取首章 */
  const load = React.useCallback(
    (keep?: { projectId?: string; chapterId?: string }) => {
      const token = ++version.current;
      // 整份重取会让任何在飞的切章请求作废：否则它的慢响应会盖掉刚取回的首章，
      // 还会让 chapterId 与 chapter 对不上（列表高亮 A、正文 B）
      chapterVersion.current++;
      const stale = (): boolean => token !== version.current;

      void (async () => {
        patch({ loading: true, error: null });
        try {
          const list = await api.listProjects(undefined);
          if (stale()) return;
          const projects = list.projects;
          const active =
            projects.find((p) => p.id === keep?.projectId) ??
            projects.find((p) => p.active) ??
            projects[0] ??
            null;
          patch({ projects, unreadable: list.unreadable, activeId: active?.id ?? null, loading: false });
          if (active === null) {
            patch({ detail: null, chapter: null, chapterId: null });
            return;
          }

          const detail = await api.readProject(undefined, active.id);
          if (stale()) return;
          if (active.id !== activeIdRef.current) return; // 期间换了作品：这份详情已过期
          // 归一化：落盘 JSON 是给人手改的，缺字段不该让整块面板被错误边界接走
          const safe = normalizeDetail(detail);
          if (safe === null) {
            patch({ detail: null, chapter: null, chapterId: null, loading: false, error: "这个作品的 project.json 缺少必要字段，面板无法显示" });
            return;
          }
          patch({ detail: safe });

          const chapterId = keep?.chapterId ?? safe.chapters[0]?.id;
          if (chapterId === undefined) {
            patch({ chapter: null, chapterId: null });
            return;
          }
          patch({ chapterLoading: true });
          const result = await api.readChapter(undefined, chapterId, active.id);
          if (stale()) return;
          // 身份校验：期间若换了作品，这份结果属于上一本，丢掉
          if (result.projectId !== activeIdRef.current) return;
          // 正文也要归一化：类型只是对未校验 JSON 的断言，`content` 是数字时面板会整块崩掉
          const safeChapter = normalizeChapter(result.chapter);
          if (safeChapter === null) {
            patch({ chapterLoading: false, error: "这一章的正文数据读不出来（缺字段），面板无法显示" });
            return;
          }
          patch({ chapter: safeChapter, chapterId: safeChapter.id, chapterLoading: false });
        } catch (error) {
          if (stale()) return;
          patch({ loading: false, chapterLoading: false, error: describe(error) });
        }
      })();
    },
    [patch],
  );

  // 挂载即取一次
  React.useEffect(() => {
    load();
  }, [load]);

  // 重连后一律失效：WebSocket 断开重连（或宿主重启）时，页面上留的是旧数据，
  // 而此刻用户最需要的恰恰是自动重取。事件由首方的 connection 在 onConnected 时发出。
  //
  // 这里**必须走 clientOps**，不能写裸 `ctx`：浏览器里没有全局 ctx，那样会在渲染时抛
  // ReferenceError 并被错误边界接走（面板一片空白）。见文件顶部 clientOps 的说明。
  React.useEffect(() => {
    const ops = clientOps;
    if (ops === undefined) return undefined;
    const off = ops.on("connection/reset", () => {
      load();
    });
    return () => {
      off();
    };
  }, [load]);

  /**
   * 写操作的统一跑法：置忙 → 请求 → **重取** → 报结果。
   *
   * 不做乐观更新（见 `PanelActions` 的说明）。失败时**保留用户输入**：只把可读的原因放进
   * `error`，编辑器里的草稿一个字都不动——冲突时用户最需要的是"我写的东西还在"。
   */
  const run = React.useCallback(
    (operation: () => Promise<string>, keep: "project" | "chapter" | "created") => {
      patch({ busy: true, error: null, notice: null });
      void (async () => {
        try {
          const message = await operation();
          const projectId = activeIdRef.current;
          const base = projectId === null ? {} : { projectId };
          if (keep === "project") {
            // 删掉当前章节后不能再按章节重取（那一章已经不存在），回到作品级
            load(projectId === null ? undefined : base);
          } else if (keep === "created") {
            const created = createdChapterRef.current;
            createdChapterRef.current = null;
            load(created === null ? base : { ...base, chapterId: created });
          } else {
            const chapterId = chapterIdRef.current;
            load(chapterId === null ? base : { ...base, chapterId });
          }
          patch({ busy: false, notice: message });
        } catch (error) {
          patch({ busy: false, error: describe(error), notice: null });
        }
      })();
    },
    [load, patch],
  );

  const actions = React.useMemo<PanelActions>(
    () => ({
      refresh: () => load(state.activeId === null ? undefined : { projectId: state.activeId }),
      selectProject: (id: string) => {
        patch({ activeId: id, detail: null, chapter: null, chapterId: null });
        load({ projectId: id });
      },
      selectChapter: (id: string) => {
        // 作品 id 必须从 **ref** 读，不能从渲染闭包读：切作品是「立刻改 activeId +
        // 异步取详情」，旧列表还挂在屏幕上时点它，闭包里的 activeId 已经是新作品，
        // 会拿新作品去要旧章节——解析成功的话正文就串台了。
        const projectId = activeIdRef.current;
        if (projectId === null) return;
        // 章节请求用**自己的**版本号：不能借用 version，否则会把还在跑的 load()
        // 判成过期而中途放弃（面板会卡在半加载状态）。
        const token = ++chapterVersion.current;
        patch({ chapterLoading: true, error: null, chapterId: id });
        void (async () => {
          try {
            const result = await api.readChapter(undefined, id, projectId);
            if (token !== chapterVersion.current) return;
            // 再校一次身份：期间若切了作品，这个响应属于上一本，丢掉
            if (result.projectId !== activeIdRef.current) return;
            patch({ chapter: result.chapter, chapterId: result.chapter.id, chapterLoading: false });
          } catch (error) {
            if (token !== chapterVersion.current) return;
            patch({ chapterLoading: false, error: describe(error) });
          }
        })();
      },

      saveChapter: (content: string) => {
        const projectId = activeIdRef.current;
        const chapterId = chapterIdRef.current;
        // "我基于哪一版改的"就是**加载进来时那份正文**（不是编辑器里的草稿）：
        // 宿主侧拿它做内容比对，对不上就是 409
        const expected = loadedContentRef.current;
        if (projectId === null || chapterId === null || expected === null) return;
        run(
          () =>
            api
              .saveChapter(undefined, projectId, chapterId, content, expected)
              .then((saved) => `已保存（${String(saved.words)} 字）`),
          "chapter",
        );
      },

      createChapter: (title: string) => {
        const projectId = activeIdRef.current;
        if (projectId === null) return;
        run(
          () =>
            api.createChapter(undefined, projectId, title).then((created) => {
              // 新建的章节要立刻选中它，否则用户点了"新建"却看不到自己在编辑什么
              createdChapterRef.current = created.chapter.id;
              return `已新建「${created.chapter.title}」`;
            }),
          "created",
        );
      },

      renameChapter: (id: string, title: string) => {
        const projectId = activeIdRef.current;
        if (projectId === null) return;
        run(() => api.renameChapter(undefined, projectId, id, title).then(() => "已改名"), "chapter");
      },

      deleteChapter: (id: string) => {
        const projectId = activeIdRef.current;
        if (projectId === null) return;
        // 删掉的是"当前这一章"时不能按 chapter 重取（那一章已经不存在了），回到作品级
        run(() => api.deleteChapter(undefined, projectId, id).then(() => "已删除"), "project");
      },

      moveChapter: (id: string, direction: "up" | "down") => {
        const projectId = activeIdRef.current;
        if (projectId === null) return;
        run(
          () =>
            api
              .moveChapter(undefined, projectId, id, direction)
              .then(() => (direction === "up" ? "已上移" : "已下移")),
          "chapter",
        );
      },

      setTargetWords: (words: number | null) => {
        const projectId = activeIdRef.current;
        if (projectId === null) return;
        run(
          () =>
            api.setTargetWords(undefined, projectId, words).then((saved) =>
              saved.targetWords === null ? "已清除目标字数" : `目标字数已设为 ${String(saved.targetWords)} 字`,
            ),
          "chapter",
        );
      },

      importCharacter: (file: File) => {
        const projectId = activeIdRef.current;
        if (projectId === null) return;
        run(
          () =>
            api.importCharacter(undefined, projectId, file).then((imported) => {
              const lore =
                imported.mergedLoreEntries > 0 ? `，并入 ${String(imported.mergedLoreEntries)} 条词条` : "";
              const note = imported.avatarNote === undefined ? "" : `（${imported.avatarNote}）`;
              return `已导入「${imported.character.name}」${lore}${note}`;
            }),
          "chapter",
        );
      },

      setCharacterActive: (id: string, active: boolean) => {
        const projectId = activeIdRef.current;
        if (projectId === null) return;
        run(
          () =>
            api
              .setCharacterActive(undefined, projectId, id, active)
              .then(() => (active ? "已让这张卡参与写作" : "已让这张卡退出写作")),
          "chapter",
        );
      },

      deleteCharacter: (id: string) => {
        const projectId = activeIdRef.current;
        if (projectId === null) return;
        run(() => api.deleteCharacter(undefined, projectId, id).then(() => "已删除角色卡"), "chapter");
      },
    }),
    [load, patch, run, state.activeId],
  );

  return { state, actions };
}

function describe(error: unknown): string {
  if (error instanceof ApiFailure) {
    if (error.code === "unknown_workspace") {
      return "尚未确定工作目录：请先在本会话里让模型调用任意 novel_* 工具（或用 /novel），再点刷新。";
    }
    if (error.code === "stale") {
      return "这一章在你编辑期间被改过了（模型或另一个窗口写过它）。你改的内容**没有保存**——请点「重新加载」拿到最新正文，再在最新的一版上重做改动。";
    }
    if (error.code === "cross_origin") {
      return "写请求被拒绝：它看起来不是从这个页面发出去的。刷新页面后重试。";
    }
    if (error.code === "needs_confirm") {
      return "这个操作需要先确认（面板上的确认没有生效？）。";
    }
    if (error.code === "too_large") {
      return "文件太大了（角色卡上限 8 MB）。";
    }
    if (error.code === "no_chapters") {
      return "这本还没有章节：先新建一章。";
    }
    if (error.code === "at_edge") {
      return "这一章已经在头/尾了。";
    }
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
