/**
 * Web 路由的真实请求测试：驱动 `/api/novel.*` 三条只读路由，断言**状态码与 JSON 结构**。
 *
 * 为什么需要：这层是面板与数据之间的唯一通道，而它的两处逻辑**从没被测过**——
 * (1) 错误码映射（我把它从"message 正则"改成"按 code 映射"，改的就是这里）；
 * (2) 未注册工作区时的 403 分支。
 * 映射错了用户看到的解释就是错的（比如把"章节名有歧义、请指明"报成 500 内部错误）。
 *
 * 手法：真 `NovelStore` + 真 fs + 一个假的 `connection.fetch` 注册表（只收集路由），
 * 然后**构造真 Request 调过去**，检查真 Response。
 *
 * 必须用 DSH 自带的 Electron Node 运行。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

check("三条路由都注册了", routes.size === 3, [...routes.keys()].join(", "));
for (const path of ["/api/novel.projects", "/api/novel.project", "/api/novel.chapter"]) {
  check(`路由 ${path} 存在`, routes.has(path));
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

rmSync(workspace, { recursive: true, force: true });
console.log(`\n${failed === 0 ? "全部通过" : `${String(failed)} 项失败`}：${String(passed + failed)} 项检查`);
process.exit(failed === 0 ? 0 : 1);
