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

export interface PanelState {
  loading: boolean;
  chapterLoading: boolean;
  error: string | null;
  projects: ProjectSummary[];
  unreadable: { id: string; error: string }[];
  activeId: string | null;
  detail: ProjectDetail | null;
  chapter: ChapterDetail["chapter"] | null;
}

export interface PanelActions {
  refresh(): void;
  selectProject(id: string): void;
  selectChapter(id: string): void;
}

const INITIAL: PanelState = {
  loading: true,
  chapterLoading: false,
  error: null,
  projects: [],
  unreadable: [],
  activeId: null,
  detail: null,
  chapter: null,
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
  /** 取数版本：每次发起请求自增，回调只在版本仍然最新时落地 */
  const version = React.useRef(0);

  const patch = React.useCallback((next: Partial<PanelState>) => {
    setState((prev) => ({ ...prev, ...next }));
  }, []);

  /** 唯一的取数入口：列作品 → 选当前作品 → 取详情 → 取首章 */
  const load = React.useCallback(
    (keep?: { projectId?: string; chapterId?: string }) => {
      const token = ++version.current;
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
            patch({ detail: null, chapter: null });
            return;
          }

          const detail = await api.readProject(undefined, active.id);
          if (stale()) return;
          patch({ detail });

          const chapterId = keep?.chapterId ?? detail.chapters[0]?.id;
          if (chapterId === undefined) {
            patch({ chapter: null });
            return;
          }
          patch({ chapterLoading: true });
          const result = await api.readChapter(undefined, chapterId, active.id);
          if (stale()) return;
          patch({ chapter: result.chapter, chapterLoading: false });
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

  const actions = React.useMemo<PanelActions>(
    () => ({
      refresh: () => load(state.activeId === null ? undefined : { projectId: state.activeId }),
      selectProject: (id: string) => {
        patch({ activeId: id, detail: null, chapter: null });
        load({ projectId: id });
      },
      selectChapter: (id: string) => {
        const projectId = state.activeId;
        if (projectId === null) return;
        const token = ++version.current;
        patch({ chapterLoading: true, error: null });
        void (async () => {
          try {
            const result = await api.readChapter(undefined, id, projectId);
            if (token !== version.current) return;
            patch({ chapter: result.chapter, chapterLoading: false });
          } catch (error) {
            if (token !== version.current) return;
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
