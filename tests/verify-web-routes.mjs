/**
 * Web 路由的真实请求测试：驱动 `/api/novel.*` 的读写路由，断言**状态码与 JSON 结构**。
 *
 * 为什么需要：这层是面板与数据之间的唯一通道。三条只读路由当年从没被测过，而错误码映射
 * （从"message 正则"改成"按 code 映射"）与 403 分支都只在这里能验。现在多了写路由，
 * 于是又多了四件只在这一层存在的事：同源校验、`expectedContent` 的内容级 CAS、
 * 危险操作的确认闸、以及"写请求也要过 cwd 白名单"。
 *
 * 手法：真 `NovelStore` + 真 fs + 一个假的 `connection.fetch` 注册表（只收集路由），
 * 然后**构造真 Request 调过去**，检查真 Response。
 *
 * 必须用 DSH 自带的 Electron Node 运行。
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { load, registerHarnessHook } from "./harness-loader.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
registerHarnessHook(repo);

let passed = 0;
let failed = 0;
const check = (label, ok, extra = "") => {
  if (ok) {
    passed++;
    console.log(`✓ ${label}${extra ? `  ${extra}` : ""}`);
  } else {
    failed++;
    console.log(`✗ ${label}${extra ? `  ${extra}` : ""}`);
  }
};

// ── 装配真实 store + 假 connection ──────────────────────────────────
const { Context } = await load("@deepseek-ai/cordis");
const { default: SystemPrompt } = await load("@deepseek-ai/dsh-system-prompt");
const { default: ToolRuntime } = await load("@deepseek-ai/dsh-tools");
const { default: LocalFileSystem } = await load("@deepseek-ai/dsh-fs-local");
const { default: SkillRegistry } = await load("@deepseek-ai/dsh-skill");
const { default: SandboxPolicy } = await load("@deepseek-ai/dsh-sandbox-policy");
const { default: SessionProjection } = await load("@deepseek-ai/dsh-session-projection");

const workspace = mkdtempSync(join(tmpdir(), "nn-api-"));
mkdirSync(join(workspace, ".git"), { recursive: true });
const ctx = new Context();
await ctx.plugin(SessionProjection);
await ctx.plugin(SandboxPolicy);
await ctx.plugin(SystemPrompt);
await ctx.plugin(ToolRuntime);
await ctx.plugin(LocalFileSystem, { cwd: workspace });
await ctx.plugin(SkillRegistry);

// 假 connection：只收集注册进来的路由（path → route）
const routes = new Map();
ctx.provide("connection", {
  fetch: {
    register(route) {
      routes.set(route.path, route);
      return Promise.resolve();
    },
  },
});

// 本测试用**手工构造的会话**驱动工具（`{ header: { cwd } }`），而真 sandboxPolicy 会去读会话
// projection（`session.snapshotEvents()`）——假会话没有那个方法，会抛
// "session.snapshotEvents is not a function"（那条正是我们修过的线上问题）。
// 「store 必须把真 Session 透传给策略」已由 `npm run test:sandbox` 在**真实策略**上覆盖，
// 所以这里把策略解析换成桩：本测试要验的是路由的状态码与 JSON 结构，不是沙箱。
ctx.sandboxPolicy.resolve = () => ({ mode: "danger-full-access", workspaceRoot: workspace });

await ctx.plugin(await load("dsh-novelnovel"));
await new Promise((resolve) => setTimeout(resolve, 200));

check("四条路由都注册了", routes.size === 4, [...routes.keys()].join(", "));
for (const path of [
  "/api/novel.projects",
  "/api/novel.project",
  "/api/novel.chapter",
  "/api/novel.character",
]) {
  check(`路由 ${path} 存在`, routes.has(path));
}
{
  // 读写共用同一个 path（第二次 register 会覆盖第一次，那样 GET 会神秘消失）——这里钉住
  const chapterRoute = routes.get("/api/novel.chapter");
  check(
    "同一 path 上读写都声明了（不会被覆盖掉一个）",
    chapterRoute.methods.includes("GET") && chapterRoute.methods.includes("POST"),
    chapterRoute.methods.join("/"),
  );
}

/** 调一条路由，返回 { status, body } */
async function hit(path, params = {}) {
  const route = routes.get(path);
  const url = new URL(`http://localhost${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await route.fetch(new Request(url));
  let body;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
}

/**
 * 发一条**写**请求。
 *
 * `body` 是字符串/字节时原样送（角色卡上传走这条），否则按 JSON 序列化。
 * `headers` 用来构造跨站/跨源的请求——同源校验只看请求头，这是唯一能验它的方式。
 */
async function send(path, params = {}, body = {}, headers = {}) {
  const route = routes.get(path);
  const url = new URL(`http://localhost${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const raw = typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body);
  const response = await route.fetch(
    new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: raw,
    }),
  );
  let parsed;
  try {
    parsed = await response.json();
  } catch {
    parsed = undefined;
  }
  return { status: response.status, body: parsed };
}

/**
 * 构造一个"像 Request 一样"的最小对象。
 *
 * 为什么需要：`Origin` 是 Fetch 规范里的 **forbidden header name**，Node 的 `new Request(…, {headers})`
 * 会把它悄悄丢掉——想验"跨源请求被拒"就只能自己造一个。它读的只有
 * `method` / `url` / `headers.get` / `text()` / `arrayBuffer()` 这几样。
 */
function fakeRequest({ method = "POST", url, headers = {}, body = "" }) {
  const lowered = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    method,
    url,
    headers: { get: (name) => lowered.get(name.toLowerCase()) ?? null },
    text: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  };
}

/** 用假 Request 发一条写请求（只在需要构造 forbidden header 时用） */
async function sendFake(path, params, body, headers) {
  const route = routes.get(path);
  const url = new URL(`http://localhost${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await route.fetch(
    fakeRequest({ url: url.href, headers, body: JSON.stringify(body) }),
  );
  let parsed;
  try {
    parsed = await response.json();
  } catch {
    parsed = undefined;
  }
  return { status: response.status, body: parsed };
}

// ── 先造数据：走工具（与真实用法一致）──────────────────────────────
const registered = new Map();
const tools = ctx.tools;
const reg = tools.register.bind(tools);
tools.register = (definition) => {
  registered.set(definition.name, definition);
  return reg(definition);
};
// 注册顺序在插件 apply 里已经走完，这里直接用 ctx.tools.get
const exec = { agent: { id: "a", session: { header: { cwd: workspace } } }, signal: new AbortController().signal };
const call = (name, args) =>
  ctx.tools.get(name).execute({ ...args }, exec).then(
    (result) => ({ ok: true, result }),
    (error) => ({ ok: false, error: String(error?.message ?? error) }),
  );

const created = await call("novel_project", { action: "create", title: "接口" });
const projectId = created.result?.details?.project_id;
check("准备：建好作品", typeof projectId === "string", String(projectId));
await call("novel_chapter", { action: "create", title: "第一章", text: "正文一" });
await call("novel_chapter", { action: "create", title: "序", text: "序章正文" });

// ── 正常路径 ───────────────────────────────────────────────────────
console.log("--- 正常路径 ---");
{
  const listed = await hit("/api/novel.projects");
  check("projects 返回 200", listed.status === 200, String(listed.status));
  check("projects 有 projects 数组", Array.isArray(listed.body?.data?.projects), JSON.stringify(listed.body?.data)?.slice(0, 80));
  check(
    "projects 的条目字段完整（面板依赖这四个）",
    (() => {
      const first = listed.body?.data?.projects?.[0];
      return (
        typeof first?.id === "string" &&
        typeof first?.title === "string" &&
        typeof first?.chapters === "number" &&
        typeof first?.words === "number"
      );
    })(),
    JSON.stringify(listed.body?.data?.projects?.[0]),
  );
}
{
  const detail = await hit("/api/novel.project", { project: projectId });
  check("project 返回 200", detail.status === 200, String(detail.status));
  check("project 带 chapters 数组", Array.isArray(detail.body?.data?.chapters), "");
  check("project 带 lorebook 数组", Array.isArray(detail.body?.data?.lorebook), "");
  check("project 带 characters 数组", Array.isArray(detail.body?.data?.characters), "");
}
{
  const chapter = await hit("/api/novel.chapter", { chapter: "第一章" });
  check("chapter 返回 200", chapter.status === 200, String(chapter.status));
  check("chapter 带正文", chapter.body?.data?.chapter?.content === "正文一", JSON.stringify(chapter.body?.data?.chapter?.content));
  check("chapter 带 projectId（面板用它做身份校验）", typeof chapter.body?.data?.projectId === "string", String(chapter.body?.data?.projectId));
}

// ── 错误映射：这些以前全被报成 500 ─────────────────────────────────
console.log("--- 错误码映射 ---");
{
  // 真正的歧义：**没有任何标题精确等于查询**，但两条标题都包含它。
  // 注意别用已经存在的标题当查询——准备阶段建过一章标题就叫「序」，
  // 精确匹配会命中它并正常返回 200（那是对的，我第一次就是这么误判的）。
  await call("novel_chapter", { action: "create", title: "第一幕", text: "幕一" });
  const made = await call("novel_chapter", { action: "create", title: "第二幕", text: "幕二" });
  check("准备：造出两条都含「幕」的章节", made.ok === true, made.ok ? "" : made.error);
  const ambiguous = await hit("/api/novel.chapter", { chapter: "幕" });
  check(
    "章节名歧义 → 409（不是 500）",
    ambiguous.status === 409,
    `status=${String(ambiguous.status)} code=${String(ambiguous.body?.error?.code)}`,
  );
  check("歧义带可读原因", /ambiguous/i.test(String(ambiguous.body?.error?.message)), String(ambiguous.body?.error?.message).slice(0, 70));
}
{
  const missing = await hit("/api/novel.chapter", { chapter: "不存在的章节" });
  check(
    "章节找不到 → 404（不是 500：这条以前是 500）",
    missing.status === 404,
    `status=${String(missing.status)} code=${String(missing.body?.error?.code)}`,
  );
}
{
  const missingProject = await hit("/api/novel.project", { project: "不存在的作品" });
  check(
    "作品找不到 → 404",
    missingProject.status === 404,
    `status=${String(missingProject.status)} code=${String(missingProject.body?.error?.code)}`,
  );
}
{
  // 未注册的 cwd → 403；且**不该**回已知工作目录的绝对路径
  const forbidden = await hit("/api/novel.projects", { cwd: "Z:\\definitely-not-a-workspace" });
  check("未注册的工作区 → 403", forbidden.status === 403, String(forbidden.status));
  check("403 的 code 是 unknown_workspace", forbidden.body?.error?.code === "unknown_workspace", String(forbidden.body?.error?.code));
  const serialized = JSON.stringify(forbidden.body);
  check(
    "403 不回已知工作目录的绝对路径（信息泄露）",
    !serialized.includes("nn-api-") && !serialized.includes(workspace),
    serialized.slice(0, 120),
  );
}

// ── 索引坏掉时不回 HTML 错误页，而是结构化 JSON ────────────────────
console.log("--- 坏数据也要回 JSON ---");
{
  const indexPath = join(workspace, ".novelnovel", "projects", projectId, "chapters", "index.json");
  const backup = (await import("node:fs")).readFileSync(indexPath, "utf8");
  writeFileSync(indexPath, "{ 不是合法 JSON", "utf8");
  const broken = await hit("/api/novel.project", { project: projectId });
  check("章节索引坏掉 → 4xx/5xx（不是 200）", broken.status >= 400, String(broken.status));
  check("坏数据回的是 JSON body（不是 HTML 错误页）", broken.body?.error !== undefined, JSON.stringify(broken.body)?.slice(0, 90));
  check(
    "5xx 不回绝对路径（信息泄露）",
    !JSON.stringify(broken.body).includes(workspace),
    JSON.stringify(broken.body).slice(0, 120),
  );
  writeFileSync(indexPath, backup, "utf8");
}

// ── 写路由：章节的增 / 改 / 存 / 排 / 删 ────────────────────────────
console.log("--- 写路由：章节 ---");
const chapterFileOf = (id) =>
  join(workspace, ".novelnovel", "projects", projectId, "chapters", `${id}.md`);
{
  const made = await send(
    "/api/novel.chapter",
    { project: projectId },
    { action: "create", title: "第三章 面板新建" },
  );
  check("新建章节 → 201", made.status === 201, `${String(made.status)} ${String(made.body?.error?.code ?? "")}`);
  const id = made.body?.data?.chapter?.id;
  check("新建返回章节 id", typeof id === "string", String(id));

  // 保存：内容相等才写（面板把"读到的那份"回传当基准）
  const read = await hit("/api/novel.chapter", { chapter: id, project: projectId });
  const loaded = read.body?.data?.chapter?.content;
  const saved = await send(
    "/api/novel.chapter",
    { project: projectId },
    { action: "write", chapter: id, content: "面板写下的正文", expectedContent: loaded },
  );
  check("保存正文 → 200", saved.status === 200, `${String(saved.status)} ${String(saved.body?.error?.message ?? "")}`);
  check("保存真的落盘", readFileSync(chapterFileOf(id), "utf8") === "面板写下的正文");
  check("保存回传新的字数", typeof saved.body?.data?.words === "number", String(saved.body?.data?.words));

  // 冲突：仍拿**旧**内容当基准再存 → 409，且磁盘不动
  const conflict = await send(
    "/api/novel.chapter",
    { project: projectId },
    { action: "write", chapter: id, content: "第二次覆盖", expectedContent: loaded },
  );
  check(
    "基准对不上 → 409 stale（不是静默覆盖）",
    conflict.status === 409 && conflict.body?.error?.code === "stale",
    `${String(conflict.status)} ${String(conflict.body?.error?.code ?? "")}`,
  );
  check("冲突时磁盘上的正文没变", readFileSync(chapterFileOf(id), "utf8") === "面板写下的正文");
  check(
    "冲突文案说得清是「谁改的」",
    /changed while you were editing/.test(String(conflict.body?.error?.message)),
    String(conflict.body?.error?.message).slice(0, 90),
  );

  // 不给基准 → 400：面板不许"盲写"
  const noBase = await send(
    "/api/novel.chapter",
    { project: projectId },
    { action: "write", chapter: id, content: "x" },
  );
  check("不带 expectedContent → 400（不给盲写的机会）", noBase.status === 400, String(noBase.status));

  const renamed = await send(
    "/api/novel.chapter",
    { project: projectId },
    { action: "rename", chapter: id, title: "第三章 改过名" },
  );
  check(
    "改名 → 200 且落盘",
    renamed.status === 200 &&
      JSON.parse(readFileSync(join(workspace, ".novelnovel", "projects", projectId, "chapters", "index.json"), "utf8")).items.some(
        (item) => item.id === id && item.title === "第三章 改过名",
      ),
    String(renamed.status),
  );

  const moved = await send(
    "/api/novel.chapter",
    { project: projectId },
    { action: "move", chapter: id, direction: "up" },
  );
  check("上移 → 200", moved.status === 200, String(moved.status));
  // 一直上移到头：那时必须报 at_edge，而不是"静默什么都没发生"
  let edge = null;
  for (let i = 0; i < 12 && edge === null; i++) {
    const attempt = await send(
      "/api/novel.chapter",
      { project: projectId },
      { action: "move", chapter: id, direction: "up" },
    );
    if (attempt.status !== 200) edge = attempt;
  }
  check(
    "移到头了再上移 → 409 at_edge（不是静默无事发生）",
    edge?.status === 409 && edge?.body?.error?.code === "at_edge",
    `${String(edge?.status)} ${String(edge?.body?.error?.code ?? "(一直 200，没到头)")}`,
  );

  const noConfirm = await send(
    "/api/novel.chapter",
    { project: projectId },
    { action: "delete", chapter: id },
  );
  check(
    "删除不带 confirm → 400 且文件还在",
    noConfirm.status === 400 && existsSync(chapterFileOf(id)),
    `${String(noConfirm.status)} ${String(noConfirm.body?.error?.code ?? "")}`,
  );
  const deleted = await send(
    "/api/novel.chapter",
    { project: projectId },
    { action: "delete", chapter: id, confirm: true },
  );
  check("带 confirm 才真删（文件也没了）", deleted.status === 200 && !existsSync(chapterFileOf(id)), String(deleted.status));

  // 拖拽落点：把一章放到另一章的 before/after——路由层只做参数校验与委派，
  // 真正的「before/after 语义」在 computeReorder（domain 单测覆盖）。
  const made1 = await send("/api/novel.chapter", { project: projectId }, { action: "create", title: "拖拽 A" });
  const made2 = await send("/api/novel.chapter", { project: projectId }, { action: "create", title: "拖拽 B" });
  const idA = made1.body?.data?.chapter?.id;
  const idB = made2.body?.data?.chapter?.id;
  const reordered = await send(
    "/api/novel.chapter",
    { project: projectId },
    { action: "reorder", chapter: idB, target: idA, position: "before" },
  );
  check("reorder → 200", reordered.status === 200, `${String(reordered.status)} ${String(reordered.body?.error?.message ?? "")}`);
  const orderNow = reordered.body?.data?.order ?? [];
  check(
    "reorder 回传新顺序，且 B 在 A 之前",
    orderNow.indexOf(idB) >= 0 && orderNow.indexOf(idB) === orderNow.indexOf(idA) - 1,
    JSON.stringify(orderNow),
  );
  const badTarget = await send(
    "/api/novel.chapter",
    { project: projectId },
    { action: "reorder", chapter: idA, target: "不存在的章节", position: "before" },
  );
  check("reorder 目标不存在 → 404", badTarget.status === 404, String(badTarget.status));
  const selfMove = await send(
    "/api/novel.chapter",
    { project: projectId },
    { action: "reorder", chapter: idA, target: idA, position: "after" },
  );
  check("reorder 相对自己 → 400", selfMove.status === 400, String(selfMove.status));
  const badPosition = await send(
    "/api/novel.chapter",
    { project: projectId },
    { action: "reorder", chapter: idA, target: idB },
  );
  check("reorder 缺 position → 400", badPosition.status === 400, String(badPosition.status));
  const unknown = await send("/api/novel.chapter", { project: projectId }, { action: "nope" });
  check("未知 action → 400", unknown.status === 400, String(unknown.status));
}

// ── 写路由：全书目标字数 ───────────────────────────────────────────
console.log("--- 写路由：目标字数 ---");
{
  const set = await send(
    "/api/novel.project",
    { project: projectId },
    { action: "set-target-words", targetWords: 120000 },
  );
  check("设置目标字数 → 200", set.status === 200, String(set.status));
  const detail = await hit("/api/novel.project", { project: projectId });
  check("详情里能读到目标字数", detail.body?.data?.project?.targetWords === 120000, String(detail.body?.data?.project?.targetWords));
  const list = await hit("/api/novel.projects");
  check(
    "作品列表也带上目标字数（面板顶栏用它算百分比）",
    list.body?.data?.projects?.[0]?.targetWords === 120000,
    String(list.body?.data?.projects?.[0]?.targetWords),
  );
  const cleared = await send(
    "/api/novel.project",
    { project: projectId },
    { action: "set-target-words", targetWords: null },
  );
  check("传 null 清空 → 字段从 project.json 里消失", cleared.status === 200 && cleared.body?.data?.targetWords === null, JSON.stringify(cleared.body?.data));
  const after = JSON.parse(readFileSync(join(workspace, ".novelnovel", "projects", projectId, "project.json"), "utf8"));
  check("清空后文件里真的没有这个键", after.targetWords === undefined, JSON.stringify(after).slice(0, 120));
  const bad = await send(
    "/api/novel.project",
    { project: projectId },
    { action: "set-target-words", targetWords: "abc" },
  );
  check("非数字 → 400", bad.status === 400, String(bad.status));
  const negative = await send(
    "/api/novel.project",
    { project: projectId },
    { action: "set-target-words", targetWords: -5 },
  );
  check("负数 → 400（store 的归一化挡住）", negative.status === 400, `${String(negative.status)} ${String(negative.body?.error?.message ?? "")}`);
}

// ── 写路由：角色卡（上传 / 参与开关 / 删除）────────────────────────
console.log("--- 写路由：角色卡 ---");
{
  // 上传分支按 content-type 分流：JSON 的卡也要用非 application/json 送（那是"文件字节"）
  const card = {
    spec: "chara_card_v2",
    data: {
      name: "路由卡",
      description: "守夜人，左眼有一道旧伤。",
      personality: "寡言",
      scenario: "",
      first_mes: "",
      mes_example: "",
      creator_notes: "",
      character_book: {
        entries: [
          { name: "灯规", keys: ["灯"], content: "灯灭则长夜入城。", enabled: true },
        ],
      },
    },
  };
  const bytes = new TextEncoder().encode(JSON.stringify(card));
  const imported = await send(
    "/api/novel.character",
    { project: projectId, filename: "路由卡.json" },
    bytes,
    { "content-type": "application/octet-stream" },
  );
  check(
    "上传角色卡 → 201",
    imported.status === 201,
    `${String(imported.status)} ${String(imported.body?.error?.message ?? "")}`,
  );
  check("导入回传解析出的名字", imported.body?.data?.character?.name === "路由卡", JSON.stringify(imported.body?.data?.character));
  check("卡内世界书并入项目 lorebook", imported.body?.data?.mergedLoreEntries === 1, String(imported.body?.data?.mergedLoreEntries));

  const detail = await hit("/api/novel.project", { project: projectId });
  const cardId = detail.body?.data?.characters?.[0]?.id;
  check("详情里能看到这张卡", typeof cardId === "string", String(cardId));

  const off = await send(
    "/api/novel.character",
    { project: projectId },
    { action: "set-active", character: cardId, active: false },
  );
  check("关掉参与 → 200 且回传 false", off.status === 200 && off.body?.data?.active === false, JSON.stringify(off.body?.data));

  const noConfirm = await send(
    "/api/novel.character",
    { project: projectId },
    { action: "delete", character: cardId },
  );
  check("删卡不带 confirm → 400", noConfirm.status === 400, `${String(noConfirm.status)} ${String(noConfirm.body?.error?.code ?? "")}`);
  const gone = await send(
    "/api/novel.character",
    { project: projectId },
    { action: "delete", character: cardId, confirm: true },
  );
  check("删卡带 confirm → 200", gone.status === 200, String(gone.status));
  const after = await hit("/api/novel.project", { project: projectId });
  check("删完列表里没有它了", after.body?.data?.characters.length === 0, String(after.body?.data?.characters.length));

  const empty = await send(
    "/api/novel.character",
    { project: projectId, filename: "空.png" },
    new Uint8Array(0),
    { "content-type": "image/png" },
  );
  check("空上传 → 400", empty.status === 400, String(empty.status));
}

// ── 写路由：同源校验与工作区白名单 ─────────────────────────────────
console.log("--- 写路由：安全 ---");
{
  const crossSite = await send(
    "/api/novel.chapter",
    { project: projectId },
    { action: "create", title: "跨站建的章" },
    { "sec-fetch-site": "cross-site" },
  );
  check(
    "跨站写请求 → 403 cross_origin",
    crossSite.status === 403 && crossSite.body?.error?.code === "cross_origin",
    `${String(crossSite.status)} ${String(crossSite.body?.error?.code ?? "")}`,
  );
  const listed = await hit("/api/novel.project", { project: projectId });
  check(
    "被拒的写请求什么都没落地",
    !listed.body?.data?.chapters.some((c) => c.title === "跨站建的章"),
    listed.body?.data?.chapters.map((c) => c.title).join(", "),
  );

  const otherOrigin = await sendFake(
    "/api/novel.chapter",
    { project: projectId },
    { action: "create", title: "别的源建的章" },
    { origin: "http://evil.example" },
  );
  check(
    "Origin 指向别的站点 → 403",
    otherOrigin.status === 403 && otherOrigin.body?.error?.code === "cross_origin",
    `${String(otherOrigin.status)} ${String(otherOrigin.body?.error?.code ?? "")}`,
  );

  const ownOrigin = await sendFake(
    "/api/novel.chapter",
    { project: projectId },
    { action: "create", title: "同源建的章" },
    { origin: "http://localhost" },
  );
  check("Origin 与本机一致 → 放行 201", ownOrigin.status === 201, String(ownOrigin.status));

  const sameOrigin = await send(
    "/api/novel.chapter",
    { project: projectId },
    { action: "create", title: "带 Sec-Fetch-Site 的同源请求" },
    { "sec-fetch-site": "same-origin" },
  );
  check("Sec-Fetch-Site: same-origin → 放行 201", sameOrigin.status === 201, String(sameOrigin.status));

  const badWorkspace = await send(
    "/api/novel.chapter",
    { cwd: "Z:\\definitely-not-a-workspace" },
    { action: "create", title: "不该建出来" },
  );
  check(
    "写路由同样走 cwd 白名单 → 403 unknown_workspace",
    badWorkspace.status === 403 && badWorkspace.body?.error?.code === "unknown_workspace",
    `${String(badWorkspace.status)} ${String(badWorkspace.body?.error?.code ?? "")}`,
  );

  const badBody = await send(
    "/api/novel.chapter",
    { project: projectId },
    "这不是 JSON",
  );
  check("坏 body → 400（不是 500）", badBody.status === 400, String(badBody.status));
}

rmSync(workspace, { recursive: true, force: true });
console.log(`\n${failed === 0 ? "全部通过" : `${String(failed)} 项失败`}：${String(passed + failed)} 项检查`);
process.exit(failed === 0 ? 0 : 1);
