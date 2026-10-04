/**
 * 宿主侧给前端的只读接口。
 *
 * 契约（来自 `ctx.connection.fetch` 的实际行为）：
 * - path 必须落在 `/api/<段>`，**精确匹配**，没有通配；段内允许 `.` `-` `_` `$`。
 * - 鉴权由 connection 的 fence 负责（loopback host + 会话 cookie）；这里不做鉴权，
 *   也**不要**读 Authorization——那套机制不接受它。
 * - 返回必须是 WHATWG `Response`，前端只认 JSON。
 * - HTTP 请求**没有会话上下文**，所以工作目录由前端用 `?cwd=` 告知，并在此校验：
 *   只接受 `NovelStore` 记录过的「工具真正用过的工作目录」。理由见 store.workspaceOf。
 *
 * 客户端用**文档相对路径**请求（`fetch("api/novel.projects?cwd=…")`），不以 `/` 开头。
 */
import type { ConnectionService, Context } from "./contract.js";
import type { NovelStore } from "./store.js";
import type { FsSession } from "./fsx.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // 面板每次挂载都重新取；缓存会让「模型刚写完的章节」看不见
      "cache-control": "no-store",
    },
  });
}

function failure(code: string, message: string, status = 400, extra?: unknown): Response {
  return json({ error: { code, message, ...(extra === undefined ? {} : { extra }) } }, status);
}

/** 把异常翻成 JSON：前端只认 JSON，HTML 错误页会让它解析失败 */
function fromError(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (/not found/i.test(message)) return failure("not_found", message, 404);
  return failure("internal_error", message, 500);
}

export function registerClientApi(ctx: Context, store: NovelStore): void {
  const connection = ctx.get<ConnectionService>("connection");
  if (connection === undefined) {
    // headless / sdk 组合没有 Web 面，注册接口没有意义
    ctx.logger.debug("novelnovel: no connection service — Web 面板接口未注册");
    return;
  }

  /** 解析并校验工作目录；不合法时返回可直接回给前端的 Response */
  const resolveSession = (request: Request): FsSession | Response => {
    const cwd = new URL(request.url).searchParams.get("cwd");
    const session = store.workspaceOf(cwd);
    if (session === undefined) {
      return failure(
        "unknown_workspace",
        cwd
          ? "this workspace is not in use by the current session"
          : "no workspace yet: run any novel_* tool first, or pass ?cwd=",
        403,
        { known: store.knownWorkspaces() },
      );
    }
    return session;
  };

  const get = (path: string, handler: (request: Request, session: FsSession) => Promise<Response>): void => {
    connection.fetch.register({
      path,
      methods: ["GET"],
      requestBody: "buffered",
      fetch: async (request) => {
        const session = resolveSession(request);
        if (session instanceof Response) return session;
        try {
          return await handler(request, session);
        } catch (error) {
          return fromError(error);
        }
      },
    });
  };

  get("/api/novel.projects", async (_request, session) => {
    const listing = await store.listProjects(session);
    return json({
      data: {
        projects: listing.projects.map((p) => ({
          id: p.project.id,
          title: p.project.title,
          chapters: p.chapterCount,
          words: p.words,
          active: p.active,
          updatedAt: p.project.updatedAt,
        })),
        unreadable: listing.unreadable,
        ...(listing.workspaceError === undefined ? {} : { workspaceError: listing.workspaceError }),
      },
    });
  });

  get("/api/novel.project", async (request, session) => {
    const projectId = await store.resolveProjectId(session, param(request, "project"));
    const [project, chapters, characters, lorebook] = await Promise.all([
      store.readProject(session, projectId),
      store.listChapters(session, projectId),
      store.listCharacters(session, projectId),
      store.readLorebook(session, projectId),
    ]);
    return json({
      data: {
        project,
        chapters: chapters.map((c) => ({
          id: c.id,
          title: c.title,
          tags: c.tags,
          words: c.words,
          updatedAt: c.updatedAt,
        })),
        characters: characters.map((c) => ({
          id: c.id,
          name: c.name,
          active: c.active,
          specVersion: c.specVersion,
          hasAvatar: c.avatar !== null,
          description: c.description,
        })),
        lorebook: lorebook.map((entry) => ({
          id: entry.id,
          name: entry.name,
          keys: entry.keys,
          enabled: entry.enabled,
        })),
      },
    });
  });

  get("/api/novel.chapter", async (request, session) => {
    const ref = param(request, "chapter");
    if (ref === undefined) return failure("missing_chapter", "chapter is required", 400);
    const projectId = await store.resolveProjectId(session, param(request, "project"));
    const chapter = await store.readChapter(session, projectId, ref);
    return json({ data: { projectId, chapter } });
  });

  ctx.logger.debug("novelnovel: Web 面板接口已注册（3 条只读路由）");
}

function param(request: Request, name: string): string | undefined {
  const value = new URL(request.url).searchParams.get(name);
  return value === null || value === "" ? undefined : value;
}
