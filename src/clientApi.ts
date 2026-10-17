/**
 * 宿主侧给 Web 面板的接口（读 + 写）。
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
 *
 * ## 写路由的三条口径（只在写这条路上成立，读没有）
 *
 * 1. **同源校验**（`crossOrigin`）：fence 保证"能连上的是本机带 cookie 的页面"，
 *    但写操作还要挡住"别的站点借浏览器发过来的请求"。这道闸不依赖上游实现。
 * 2. **写入用 `writeWorkspaceOf`**：它比读多带一个 actor（= 白名单里那个真 Session），
 *    否则「先读后写」策略看不到面板写过的文件（策略取 owner 的方式是 `actor?.agent?.session`）。
 * 3. **正文保存要内容相等**（`writeChapterBodyIfUnchanged`）：面板把它读到的那份文本回传，
 *    对不上就 409——与工具侧同一个 CAS 语义，绝不静默覆盖。
 */
import type { ConnectionFetchMethod, ConnectionService, Context } from "./contract.js";
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
  NN_BAD_TARGET_WORDS: { status: 400, code: "bad_request" },
};

/** 单次上传的上限（角色卡 PNG 一般几百 KB；给足余量，但必须有闸） */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

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
  // 危险操作的确认闸（删章节/卡片）：这是"你得先问用户"，不是内部错误
  if (/without confirm=true/.test(message)) return failure("needs_confirm", message, 400);

  // 其余一律 500，且只回固定文案——原文可能带工作区绝对路径
  ctx.logger.warn(`novelnovel: /api/novel.* failed: ${message}`);
  return failure(
    "internal_error",
    "the request failed inside the plugin; see the host log for details (reason logged with prefix \"novelnovel:\")",
    500,
  );
}

/**
 * 注册 Web 面板的接口（读写）。
 *
 * **必须走 `ctx.inject(["connection"], …)`，不能在 apply 里直接 `ctx.get("connection")`。**
 * 前者是 Cordis 的软挂载：服务还不存在时把回调排队，等它 provide 之后再执行；
 * 后者只是**查一次**，拿不到就没了、而且不会重试。插件行在 loader 里比 Web 那几行早，
 * 所以直接查的结果是稳定拿到 `undefined` → 路由永远不注册 → 面板每次取数都 404，
 * 而宿主工具一切正常（`novel_*` 能用），现场看起来像"面板坏了、插件是好的"。
 * 同一条形状的坑在 skills / commands / systemPrompt 上已经各踩过一次，这里统一。
 *
 * 没有 connection 的组合（headless / sdk）不会触发回调，接口自然不注册——那是对的，
 * 那些组合没有 Web 面。
 */
export function registerClientApi(ctx: Context, store: NovelStore): void {
  ctx.inject(["connection"], (connCtx) => {
    const connection = connCtx.get<ConnectionService>("connection");
    if (connection === undefined) {
      // inject 已保证服务在，这里只是让类型收窄；真出现说明 harness 语义变了
      connCtx.logger.warn("novelnovel: connection injected but unavailable — Web 面板接口未注册");
      return;
    }
    registerRoutes(connCtx, connection, store);
  });
}

/** 解析查询参数；空串按"没传"处理（与前端 buildRequestTarget 的约定一致） */
function param(request: Request, name: string): string | undefined {
  const value = new URL(request.url).searchParams.get(name);
  return value === null || value === "" ? undefined : value;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * 写路由的同源校验：**返回 true 表示"这是跨站请求，拒掉"**。
 *
 * 浏览器发跨站请求时会带 `Sec-Fetch-Site`（现代浏览器）或至少 `Origin`；
 * 两个都没有的（curl、脚本、首方测试）放行——它们本来也拿不到会话 cookie，
 * 而 fence 已经保证只有本机带 cookie 的页面能到这里。**只信请求头，不新增 token**：
 * 前端没有安全的存放位置，多一个"前端要记住的秘密"只会在刷新后变成故障。
 *
 * 这里的两个比较方向都曾经写反过一次（`site !== "cross-site"` 与 `host === host`），
 * 结果是**同源请求被拒、跨站请求放行**——方向一错就正好反过来，所以
 * `npm run test:routes` 两个方向都钉了用例。改这个函数时先看那两条。
 */
function crossOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site === "cross-site";
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  try {
    return new URL(origin).host !== new URL(request.url).host;
  } catch {
    return false; // Origin: null（沙箱 iframe / 本地文件）解析不了，交给 fence
  }
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    // 抛出去会被 fromError 兜成 500，而这是调用方的输入问题 → 直接在 fetch 里翻成 400
    throw Object.assign(new Error("request body must be a JSON object"), { code: "NN_BAD_BODY" });
  }
}

/** 上传的文件名：只取最后一段并去掉控制字符；扩展名交给卡解析侧的魔数嗅探 */
function safeFilename(raw: string | undefined): string {
  const base = (raw ?? "card").split(/[\\/]/).pop() ?? "card";
  // eslint-disable-next-line no-control-regex -- 控制字符会进落盘路径与错误文案
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned === "" ? "card" : cleaned.slice(0, 120);
}

function registerRoutes(
  ctx: Context,
  connection: ConnectionService,
  store: NovelStore,
): void {
  /**
   * 注册一条路由：读写共用一个 path，靠 method 分流。
   *
   * 为什么不分两次 register：path 是**精确匹配**的键，第二次注册会覆盖第一次——
   * 那样 GET 会神秘地消失，而不是报错。
   */
  const route = (
    path: string,
    methods: readonly ConnectionFetchMethod[],
    handle: (request: Request, session: FsSession, write: boolean) => Promise<Response>,
  ): void => {
    connection.fetch.register({
      path,
      methods,
      requestBody: "buffered",
      fetch: async (request) => {
        // 解析会话也要在 try 里：它一旦抛错（例如沙箱策略读不到会话 projection），
        // 异常会逃出 fetch → 连接层无 catch → webserver 兜底成**空 body 400**，
        // 前端只能看到 "request failed with 400"，拿不到任何原因。
        try {
          const write = request.method !== "GET" && request.method !== "HEAD";
          if (write && crossOrigin(request)) {
            return failure(
              "cross_origin",
              "refusing a write request that did not come from this page (cross-site request)",
              403,
            );
          }
          const cwd = param(request, "cwd");
          const session = write ? store.writeWorkspaceOf(cwd) : store.workspaceOf(cwd);
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
          return await handle(request, session, write);
        } catch (error) {
          if (errorCodeOf(error) === "NN_BAD_BODY") {
            return failure("bad_body", "request body must be a JSON object", 400);
          }
          return fromError(ctx, error);
        }
      },
    });
  };

  // ── 读：作品列表 / 作品详情 / 单章正文 ────────────────────────────────

  route("/api/novel.projects", ["GET", "POST"], async (_request, session, write) => {
    if (write) return failure("method_not_allowed", "use GET", 405);
    const listing = await store.listProjects(session);
    return json({
      data: {
        projects: listing.projects.map((p) => ({
          id: p.project.id,
          title: p.project.title,
          chapters: p.chapterCount,
          words: p.words,
          targetWords: p.project.targetWords ?? null,
          active: p.active,
          updatedAt: p.project.updatedAt,
        })),
        unreadable: listing.unreadable,
        ...(listing.workspaceError === undefined ? {} : { workspaceError: listing.workspaceError }),
      },
    });
  });

  route("/api/novel.project", ["GET", "POST"], async (request, session, write) => {
    if (write) {
      const body = await readJsonBody(request);
      const action = stringField(body.action);
      const projectId = await store.resolveProjectId(session, stringField(body.project));
      if (action !== "set-target-words") {
        return failure("unknown_action", `unsupported action "${action ?? ""}"`, 400);
      }
      const raw = body.targetWords;
      if (raw !== null && typeof raw !== "number") {
        return failure("bad_request", "targetWords must be a number or null", 400);
      }
      // 传 null 是清空（字段从 project.json 里删掉）；0 同样按清空处理（见 store 的归一化）
      const project = await store.updateProject(session, projectId, {
        targetWords: raw === null ? null : (raw as number),
      });
      return json({ data: { projectId, targetWords: project.targetWords ?? null } });
    }

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
          // 自检结论：面板上让"这一章过没过"看得见（没有就是 null）
          review: c.review === undefined ? null : { verdict: c.review.verdict, attempts: c.review.attempts },
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

  route("/api/novel.chapter", ["GET", "POST"], async (request, session, write) => {
    const body = write ? await readJsonBody(request) : {};
    const projectId = await store.resolveProjectId(
      session,
      write ? stringField(body.project) : param(request, "project"),
    );

    if (write) {
      const action = stringField(body.action);
      if (action === "create") {
        const title = stringField(body.title)?.trim();
        if (!title) return failure("bad_request", "title is required", 400);
        const goal = stringField(body.goal);
        const position = typeof body.position === "number" ? body.position : undefined;
        const chapter = await store.createChapter(session, projectId, {
          title,
          ...(goal === undefined ? {} : { goal }),
          ...(position === undefined ? {} : { position }),
        });
        return json(
          { data: { chapter: { id: chapter.id, title: chapter.title, words: chapter.words } } },
          201,
        );
      }

      const ref = stringField(body.chapter);
      if (ref === undefined || ref.trim() === "") {
        return failure("bad_request", "chapter is required", 400);
      }
      const meta = await store.resolveChapterId(session, projectId, ref);

      if (action === "write") {
        const content = stringField(body.content);
        const expected = stringField(body.expectedContent);
        if (content === undefined) return failure("bad_request", "content is required", 400);
        if (expected === undefined) {
          return failure(
            "bad_request",
            "expectedContent is required: send the text you loaded, so a save that races the model fails instead of overwriting it",
            400,
          );
        }
        const chapter = await store.writeChapterBodyIfUnchanged(
          session,
          projectId,
          meta.id,
          content,
          expected,
        );
        return json({ data: { chapterId: chapter.id, words: chapter.words } });
      }

      if (action === "rename") {
        const title = stringField(body.title)?.trim();
        if (!title) return failure("bad_request", "title is required", 400);
        const updated = await store.updateChapterMeta(session, projectId, meta.id, { title });
        return json({ data: { chapterId: updated.id, title: updated.title } });
      }

      if (action === "delete") {
        // 确认闸在 store 里（与工具侧同一个口径）；这里只是把 body.confirm 传下去
        await store.deleteChapter(session, projectId, meta.id, body.confirm === true);
        return json({ data: { chapterId: meta.id, deleted: true } });
      }

      if (action === "move") {
        const direction = stringField(body.direction);
        if (direction !== "up" && direction !== "down") {
          return failure("bad_request", 'direction must be "up" or "down"', 400);
        }
        const metas = await store.listChapterMetas(session, projectId);
        const at = metas.findIndex((item) => item.id === meta.id);
        const neighbour = at < 0 ? undefined : metas[direction === "up" ? at - 1 : at + 1];
        if (neighbour === undefined) {
          return failure("at_edge", "that chapter is already at the edge of the book", 409);
        }
        await store.moveChapter(
          session,
          projectId,
          meta.id,
          neighbour.id,
          direction === "up" ? "before" : "after",
        );
        return json({ data: { chapterId: meta.id, moved: direction } });
      }

      if (action === "reorder") {
        // 拖拽落点：把 chapter 放到 target 的 before/after。
        // 语义与 tool 侧的 computeReorder 同一套（targetId + position），不是新能力，只是多了个对外动作。
        const target = stringField(body.target) ?? "";
        const position = stringField(body.position) ?? "";
        if (target === "" || (position !== "before" && position !== "after")) {
          return failure("bad_request", 'reorder needs "target" and position "before"|"after"', 400);
        }
        if (target === meta.id) {
          return failure("bad_request", "cannot move a chapter relative to itself", 400);
        }
        const metas = await store.listChapterMetas(session, projectId);
        if (!metas.some((item) => item.id === target)) {
          return failure("not_found", `no chapter "${target}" in this project`, 404);
        }
        const ordered = await store.moveChapter(session, projectId, meta.id, target, position);
        return json({
          data: { chapterId: meta.id, placed: position, target, order: ordered.map((item) => item.id) },
        });
      }

      return failure("unknown_action", `unsupported action "${action ?? ""}"`, 400);
    }

    const ref = param(request, "chapter");
    if (ref === undefined) return failure("missing_chapter", "chapter is required", 400);
    const chapter = await store.readChapter(session, projectId, ref);
    return json({ data: { projectId, chapter } });
  });

  // ── 角色卡：导入（上传字节）/ 参与开关 / 删除 ─────────────────────────
  // 只有 POST：这条路由没有"读"的语义，卡片列表在 /api/novel.project 里一起给。

  route("/api/novel.character", ["POST"], async (request, session) => {
    const projectId = await store.resolveProjectId(session, param(request, "project"));
    const contentType = request.headers.get("content-type") ?? "";

    if (contentType.includes("application/json")) {
      const body = await readJsonBody(request);
      const action = stringField(body.action);
      const ref = stringField(body.character);
      if (ref === undefined || ref.trim() === "") {
        return failure("bad_request", "character is required", 400);
      }
      const character = await store.resolveCharacter(session, projectId, ref);
      if (action === "set-active") {
        if (typeof body.active !== "boolean") {
          return failure("bad_request", "active must be a boolean", 400);
        }
        const updated = await store.updateCharacter(session, projectId, character.id, {
          active: body.active,
        });
        return json({ data: { characterId: updated.id, active: updated.active } });
      }
      if (action === "delete") {
        await store.deleteCharacter(session, projectId, character.id, body.confirm === true);
        return json({ data: { characterId: character.id, deleted: true } });
      }
      return failure("unknown_action", `unsupported action "${action ?? ""}"`, 400);
    }

    // 上传分支：请求体就是文件字节（前端用 fetch(…, { body: file })）
    const declared = Number(request.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
      return failure("too_large", `character cards must be at most ${MAX_UPLOAD_BYTES} bytes`, 413);
    }
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength === 0) return failure("bad_request", "empty upload", 400);
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
      return failure("too_large", `character cards must be at most ${MAX_UPLOAD_BYTES} bytes`, 413);
    }
    const result = await store.importCharacterBytes(
      session,
      projectId,
      bytes,
      safeFilename(param(request, "filename")),
    );
    return json(
      {
        data: {
          character: {
            id: result.character.id,
            name: result.character.name,
            active: result.character.active,
            specVersion: result.character.specVersion,
            hasAvatar: result.character.avatar !== null,
          },
          mergedLoreEntries: result.mergedLoreEntries,
          skippedLoreEntries: result.skippedLoreEntries,
          ...(result.avatarNote === undefined ? {} : { avatarNote: result.avatarNote }),
        },
      },
      201,
    );
  });

  ctx.logger.debug("novelnovel: Web 面板接口已注册（3 条读 + 3 条写）");
}
