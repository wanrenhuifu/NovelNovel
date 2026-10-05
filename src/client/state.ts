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
  error: string | null;
  projects: ProjectSummary[];
  unreadable: { id: string; error: string }[];
  activeId: string | null;
  detail: ProjectDetail | null;
  chapter: ChapterDetail["chapter"] | null;
  /** 当前选中章节的 id：键盘导航按它定位，不去 DOM 里反查 */
  chapterId: string | null;
}

export interface PanelActions {
  refresh(): void;
  selectProject(id: string): void;
  selectChapter(id: string): void;
}

/**
 * 初始状态：**状态的单一真相**。
 * 导出它是为了让渲染测试能用同一份形状构造夹具——手抄一份字段列表迟早会与这里漂移。
 */
export const INITIAL: PanelState = {
  loading: true,
  chapterLoading: false,
  error: null,
  projects: [],
  unreadable: [],
  activeId: null,
  detail: null,
  chapter: null,
  chapterId: null,
};

export const PanelContext = React.createContext<{ state: PanelState; actions: PanelActions }>({
  state: INITIAL,
  actions: { refresh: () => undefined, selectProject: () => undefined, selectChapter: () => undefined },
});

export function usePanel(): { state: PanelState; actions: PanelActions } {
  return React.useContext<{ state: PanelState; actions: PanelActions }>(PanelContext);
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

  const patch = React.useCallback((next: Partial<PanelState>) => {
    if (next.activeId !== undefined) activeIdRef.current = next.activeId;
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
  React.useEffect(() => {
    const off = ctx.on("connection/reset", () => {
      load();
    });
    return () => {
      off();
    };
  }, [load]);

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
    }),
    [load, patch, state.activeId],
  );

  return { state, actions };
}

function describe(error: unknown): string {
  if (error instanceof ApiFailure) {
    if (error.code === "unknown_workspace") {
      return "尚未确定工作目录：请先在本会话里让模型调用任意 novel_* 工具（或用 /novel），再点刷新。";
    }
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
