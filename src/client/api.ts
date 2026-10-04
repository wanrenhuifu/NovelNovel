/**
 * 与宿主 `/api/novel.*` 路由的通信。
 *
 * 两条硬约定：
 * - 路径是**文档相对**的（`api/novel.projects`，不以 `/` 开头）——这是首方产物的写法，
 *   保证面板在带路径前缀的反向代理下也对。
 * - 认证靠同源 cookie（HttpOnly），代码里看不到也不需要 token；
 *   因此**不要**加自定义 header，也不要自己处理 401——`connection/reset` 事件才是重连信号。
 */

export interface ApiError {
  code: string;
  message: string;
  extra?: { known?: string[] };
}

export class ApiFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly extra?: { known?: string[] },
  ) {
    super(message);
  }
}

async function request<T>(path: string, params: Record<string, string | undefined>): Promise<T> {
  const url = new URL(path, "http://localhost/");
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value);
  }
  // 相对路径：保留 URL 上的 search，去掉开头的 "/"
  const target = url.pathname.slice(1) + url.search;

  const response = await fetch(target, { headers: { accept: "application/json" } });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = (body as { error?: ApiError } | undefined)?.error;
    throw new ApiFailure(
      error?.code ?? `http_${String(response.status)}`,
      error?.message ?? `request failed with ${String(response.status)}`,
      error?.extra,
    );
  }
  return (body as { data: T }).data;
}

export interface ProjectSummary {
  id: string;
  title: string;
  chapters: number;
  words: number;
  active: boolean;
  updatedAt: number;
}

export interface ProjectList {
  projects: ProjectSummary[];
  unreadable: { id: string; error: string }[];
  workspaceError?: string;
}

export interface ChapterSummary {
  id: string;
  title: string;
  tags: string[];
  words: number;
  updatedAt: number;
}

export interface CharacterSummary {
  id: string;
  name: string;
  active: boolean;
  specVersion: string;
  hasAvatar: boolean;
  description: string;
}

export interface LoreEntrySummary {
  id: string;
  name: string;
  keys: string;
  enabled: boolean;
}

export interface ProjectDetail {
  project: { id: string; title: string; synopsis: string; updatedAt: number };
  chapters: ChapterSummary[];
  characters: CharacterSummary[];
  lorebook: LoreEntrySummary[];
}

export interface ChapterDetail {
  projectId: string;
  chapter: { id: string; title: string; content: string; words: number };
}

/** 工作目录在每次请求时带上：HTTP 路由没有会话上下文（见宿主侧说明） */
export const api = {
  listProjects: (cwd?: string) => request<ProjectList>("api/novel.projects", { cwd }),
  readProject: (cwd: string | undefined, project?: string) =>
    request<ProjectDetail>("api/novel.project", { cwd, project }),
  readChapter: (cwd: string | undefined, chapter: string, project?: string) =>
    request<ChapterDetail>("api/novel.chapter", { cwd, chapter, project }),
};
