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

/**
 * 把异常翻成 JSON。
 *
 * 状态码**不靠 message 正则**：那会把「两个章节都叫序，请指明哪一个」这类
 * 用户可自行纠正的情况报成 500，也会把 fs 文案里带 "not found" 的误判成 404。
 * store 侧抛的错误带 `code`（`NN_*`）时按 code 映射；没有 code 的才落到 500，
 * 并且 5xx 只回固定文案——内部错误信息里可能带绝对路径。
 */
const CODE_STATUS: Record<string, { status: number; code: string }> = {
  NN_NOT_FOUND: { status: 404, code: "not_found" },
  NN_AMBIGUOUS: { status: 409, code: "ambiguous" },
  NN_NEEDS_PROJECT: { status: 400, code: "needs_project" },
  NN_NO_CHAPTERS: { status: 404, code: "no_chapters" },
  NN_BAD_INDEX: { status: 422, code: "bad_index" },
  NN_STALE_VERSION: { status: 409, code: "stale" },
};

/** 把 store 的错误标记成可映射的 code（改 store 抛点时可逐步替换正则兜底） */
export function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function fromError(ctx: Context, error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  const code = errorCodeOf(error);
  const mapped = code === undefined ? undefined : CODE_STATUS[code];
  if (mapped !== undefined) return failure(mapped.code, message, mapped.status);

  // 兼容尚未带 code 的既有错误：只认最强的几条特征，不做宽泛正则。
  // `not found` 这条**必须覆盖所有实体**：章节找不到的文案是 `chapter "…" not found. Available: …`，
  // 早先只写了 `project` 开头，于是"章节不存在"被报成 500 内部错误——
  // 用户看到的是"插件内部出错了"，真相只是这一章不在。
  if (/^(project|chapter|character|entry|preset) ".+" not found/.test(message)) {
    return failure("not_found", message, 404);
  }
  if (/has no chapters yet/.test(message)) return failure("no_chapters", message, 404);
  if (/has no character cards yet/.test(message)) return failure("not_found", message, 404);
  if (/has no presets yet/.test(message)) return failure("not_found", message, 404);
  if (/is ambiguous:/.test(message)) return failure("ambiguous", message, 409);
  if (/pass project=<id> explicitly/.test(message)) return failure("needs_project", message, 400);
  if (/id cannot be used as a file name/.test(message)) return failure("bad_index", message, 422);

  // 其余一律 500，且只回固定文案——原文可能带工作区绝对路径
  ctx.logger.warn(`novelnovel: /api/novel.* failed: ${message}`);
  return failure(
    "internal_error",
    "the request failed inside the plugin; see the host log for details (reason logged with prefix \"novelnovel:\")",
    500,
  );
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
      // 不回已知工作目录的绝对路径：前端不用它（单工作区时宿主已自动解析），
      // 回给浏览器只是多一处暴露面
      return failure(
        "unknown_workspace",
        cwd
          ? "this workspace is not in use by the current session"
          : "no workspace yet: run any novel_* tool in a session first",
        403,
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
        // 解析会话也要在 try 里：它一旦抛错（例如沙箱策略读不到会话 projection），
        // 异常会逃出 fetch → 连接层无 catch → webserver 兜底成**空 body 400**，
        // 前端只能看到 "request failed with 400"，拿不到任何原因。
        try {
          const session = resolveSession(request);
          if (session instanceof Response) return session;
          return await handler(request, session);
        } catch (error) {
          return fromError(ctx, error);
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
