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

/**
 * 把路由路径 + 查询参数拼成**文档相对**的请求地址（不以 `/` 开头）。
 *
 * 抽出来是为了能测：它看着只有两行，但错了面板就整个取不到数据，而这半边从来没有过验证。
 * 三条不能破的约定：
 * - 前导 `/` 必须去掉（去掉后才是文档相对，反代前缀下也对）；
 * - `value === ""` 与 `undefined` 一样跳过——空串会被后端当成"没传"，但拼上去会让
 *   `known_workspace` 那类分支收到 `cwd=` 而不是缺省；
 * - 已有 query 要保留（目前调用方都不带，但拼装逻辑不能假设）。
 */
export function buildRequestTarget(path: string, params: Record<string, string | undefined>): string {
  const url = new URL(path, "http://localhost/");
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value);
  }
  return url.pathname.slice(1) + url.search;
}

/**
 * 解析响应：`{ data }` 解包，`{ error: { code, message, extra } }` 翻成 `ApiFailure`。
 * 非 JSON 的 body（首方兜底会回空 body）不能让调用方拿到 `undefined` 就崩——给出带状态码的兜底文案。
 */
export function parseResponse<T>(ok: boolean, status: number, body: unknown): T {
  if (!ok) {
    const error = (body as { error?: ApiError } | undefined)?.error;
    throw new ApiFailure(
      error?.code ?? `http_${String(status)}`,
      error?.message ?? `request failed with ${String(status)}`,
      error?.extra,
    );
  }
  return (body as { data: T }).data;
}

async function request<T>(path: string, params: Record<string, string | undefined>): Promise<T> {
  const response = await fetch(buildRequestTarget(path, params), {
    headers: { accept: "application/json" },
  });
  const body: unknown = await response.json().catch(() => undefined);
  return parseResponse<T>(response.ok, response.status, body);
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
