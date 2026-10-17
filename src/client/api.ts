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

/**
 * 写请求（JSON body）。
 *
 * `content-type: application/json` 是**协议要求**，不是认证头——认证仍然只靠同源 cookie
 * （见文件头）。宿主侧对写请求另有一道同源校验（`Sec-Fetch-Site` / `Origin`），
 * 浏览器会自动带上，这里什么都不用做。
 */
async function send<T>(
  path: string,
  params: Record<string, string | undefined>,
  body: unknown,
): Promise<T> {
  const response = await fetch(buildRequestTarget(path, params), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed: unknown = await response.json().catch(() => undefined);
  return parseResponse<T>(response.ok, response.status, parsed);
}

/**
 * 上传请求：body 就是文件本身（角色卡可能是 PNG 的几千字节，也可能是几百 KB）。
 * 不走 JSON + base64：那会白白多出三分之一体积，而且宿主侧还要再解一次码。
 */
async function upload<T>(
  path: string,
  params: Record<string, string | undefined>,
  file: Blob,
): Promise<T> {
  const response = await fetch(buildRequestTarget(path, params), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": file.type === "" ? "application/octet-stream" : file.type,
    },
    body: file,
  });
  const parsed: unknown = await response.json().catch(() => undefined);
  return parseResponse<T>(response.ok, response.status, parsed);
}

export interface ProjectSummary {
  id: string;
  title: string;
  chapters: number;
  words: number;
  targetWords: number | null;
  active: boolean;
  updatedAt: number;
}

export interface ProjectList {
  projects: ProjectSummary[];
  unreadable: { id: string; error: string }[];
  workspaceError?: string;
}

/** 自检结论（`ChapterMeta.review` 的面板视图）；没有就是 null */
export interface ReviewSummary {
  verdict: "pass" | "fail" | "inconclusive";
  attempts: number;
}

export interface ChapterSummary {
  id: string;
  title: string;
  tags: string[];
  words: number;
  updatedAt: number;
  review: ReviewSummary | null;
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
  project: { id: string; title: string; synopsis: string; updatedAt: number; targetWords: number | null };
  chapters: ChapterSummary[];
  characters: CharacterSummary[];
  lorebook: LoreEntrySummary[];
}

export interface ChapterDetail {
  projectId: string;
  chapter: {
    id: string;
    title: string;
    content: string;
    words: number;
    goal: string;
    review: ReviewSummary | null;
  };
}

export interface ImportedCharacter {
  character: CharacterSummary;
  mergedLoreEntries: number;
  skippedLoreEntries: number;
  avatarNote?: string;
}

/**
 * 面板的写请求都带 `confirm: true` 的那几处（删章节 / 删卡）：确认对话框在**面板侧**
 * （用户点了"删除"才会发这个请求），请求里的字段只是把这个意图说清楚——
 * 宿主侧的确认闸与工具侧是同一个（`confirm=true` 才动手），这里不能省。
 */
export const api = {
  listProjects: (cwd?: string) => request<ProjectList>("api/novel.projects", { cwd }),
  readProject: (cwd: string | undefined, project?: string) =>
    request<ProjectDetail>("api/novel.project", { cwd, project }),
  readChapter: (cwd: string | undefined, chapter: string, project?: string) =>
    request<ChapterDetail>("api/novel.chapter", { cwd, chapter, project }),

  setTargetWords: (cwd: string | undefined, project: string | undefined, targetWords: number | null) =>
    send<{ projectId: string; targetWords: number | null }>("api/novel.project", { cwd, project }, {
      action: "set-target-words",
      targetWords,
    }),

  createChapter: (
    cwd: string | undefined,
    project: string | undefined,
    title: string,
    goal?: string,
  ) =>
    send<{ chapter: { id: string; title: string; words: number } }>(
      "api/novel.chapter",
      { cwd, project },
      { action: "create", title, ...(goal === undefined || goal === "" ? {} : { goal }) },
    ),

  /** 保存正文。`expectedContent` 是**面板读到的那份文本**：对不上就是 409（有人改过了） */
  saveChapter: (
    cwd: string | undefined,
    project: string | undefined,
    chapter: string,
    content: string,
    expectedContent: string,
  ) =>
    send<{ chapterId: string; words: number }>("api/novel.chapter", { cwd, project }, {
      action: "write",
      chapter,
      content,
      expectedContent,
    }),

  renameChapter: (cwd: string | undefined, project: string | undefined, chapter: string, title: string) =>
    send<{ chapterId: string; title: string }>("api/novel.chapter", { cwd, project }, {
      action: "rename",
      chapter,
      title,
    }),

  deleteChapter: (cwd: string | undefined, project: string | undefined, chapter: string) =>
    send<{ chapterId: string; deleted: boolean }>("api/novel.chapter", { cwd, project }, {
      action: "delete",
      chapter,
      confirm: true,
    }),

  moveChapter: (
    cwd: string | undefined,
    project: string | undefined,
    chapter: string,
    direction: "up" | "down",
  ) =>
    send<{ chapterId: string; moved: string }>("api/novel.chapter", { cwd, project }, {
      action: "move",
      chapter,
      direction,
    }),

  /** 拖拽落点：把 chapter 放到 target 的 before/after（与 ↑↓ 的 move 语义一致，但可跳位） */
  reorderChapter: (
    cwd: string | undefined,
    project: string | undefined,
    chapter: string,
    target: string,
    position: "before" | "after",
  ) =>
    send<{ chapterId: string; placed: string; target: string; order: string[] }>(
      "api/novel.chapter",
      { cwd, project },
      { action: "reorder", chapter, target, position },
    ),

  importCharacter: (cwd: string | undefined, project: string | undefined, file: File) =>
    upload<ImportedCharacter>(
      "api/novel.character",
      { cwd, project, filename: file.name },
      file,
    ),

  setCharacterActive: (
    cwd: string | undefined,
    project: string | undefined,
    character: string,
    active: boolean,
  ) =>
    send<{ characterId: string; active: boolean }>("api/novel.character", { cwd, project }, {
      action: "set-active",
      character,
      active,
    }),

  deleteCharacter: (cwd: string | undefined, project: string | undefined, character: string) =>
    send<{ characterId: string; deleted: boolean }>("api/novel.character", { cwd, project }, {
      action: "delete",
      character,
      confirm: true,
    }),
};
