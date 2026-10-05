/**
 * 探针：Web 路由用的会话必须是**真品透传**，不能是伪造物。
 *
 * 背景（独立审查实测出的致命 bug）：`workspaceOf` 曾用 `sessionFor({ header: { cwd } })`
 * 造了个假 Session 交给 `ctx.sandboxPolicy.resolve({ session })`，而真品会去读会话 projection：
 *   `TypeError: session.snapshotEvents is not a function`
 * → 三条 `/api/novel.*` 路由全部 400/空 body，前端只看到 "request failed with 400"。
 *
 * 修法：把 `workspaces` 从 `Set<cwd>` 改成 `Map<cwd, Session>`，记住**当初那个 Session 实例**，
 * 解析时原样复用它。本探针断言的就是这件事——用真实的 `dsh-sandbox-policy`，
 * 观察 `resolve` 究竟收到了哪个对象。
 *
 * 必须用 DSH 自带的 Electron Node 运行（sandboxPolicy 在 app.asar 里）。
 * 产物落在仓库内而不是 %TEMP%：第三方依赖（@lenml/char-card-reader）只装在仓库里。
 */
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rmSync } from "node:fs";
import { build } from "esbuild";
import { load, registerHarnessHook } from "./harness-loader.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
registerHarnessHook(repo);

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail: ok ? undefined : detail });

// ── 装配：真实 sandboxPolicy + 真实的 NovelStore（源码，不经插件入口）──
const { Context } = await load("@deepseek-ai/cordis");
const SessionProjection = (await load("@deepseek-ai/dsh-session-projection")).default;
const SandboxPolicy = (await load("@deepseek-ai/dsh-sandbox-policy")).default;
const LocalFileSystem = (await load("@deepseek-ai/dsh-fs-local")).default;

const ctx = new Context();
await ctx.plugin(SessionProjection);
await ctx.plugin(SandboxPolicy);
await ctx.plugin(LocalFileSystem, { cwd: process.cwd() });
check("真实 sandboxPolicy 已挂载", typeof ctx.sandboxPolicy?.resolve === "function");

// 观察 resolve 收到了什么（用同一个实例判断，不看形状）
const received = [];
const originalResolve = ctx.sandboxPolicy.resolve.bind(ctx.sandboxPolicy);
ctx.sandboxPolicy.resolve = (request) => {
  received.push(request?.session);
  return originalResolve(request);
};

const outfile = join(repo, ".novelnovel-store-probe.mjs");
await build({
  entryPoints: [join(repo, "src", "store.ts")],
  outfile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  external: ["@deepseek-ai/*", "@lenml/char-card-reader"],
  logLevel: "error",
});
const { NovelStore } = await import(pathToFileURL(outfile).href);
rmSync(outfile, { force: true });

const config = { dataDir: ".novelnovel", maxPrevChapterCount: 5, maxPrevChapterChars: 8000 };

// ── 1. 伪造对象确实会被真品拒绝（坑是真的）──────────────────────
let fakeThrew = null;
try {
  ctx.sandboxPolicy.resolve({ session: { header: { cwd: process.cwd() } } });
} catch (error) {
  fakeThrew = error;
}
check(
  "伪造的 Session 会被真品拒绝（这正是曾经让三条路由全灭的原因）",
  fakeThrew !== null,
  fakeThrew === null ? "竟然没抛错——上游行为变了，本测试要重新评估" : undefined,
);
if (fakeThrew !== null) console.log(`  伪造对象的报错：${String(fakeThrew.message).split("\n")[0]}`);

// ── 2. store 透传的是「当初那个实例」────────────────────────────
// 这里把 resolve 换成**不碰投影的桩**：本步断言的是「store 传了哪个对象」，
// 而不是「假对象能不能当会话用」（后者不可能，也不必测）。
// 用真品 sandboxPolicy 验证「假对象被拒」是上面第 1 步的事。
const passedIn = [];
ctx.sandboxPolicy.resolve = (request) => {
  passedIn.push(request?.session);
  return { mode: "read-only", workspaceRoot: process.cwd() };
};

const store = new NovelStore(ctx, config);
const recorded = { header: { cwd: process.cwd() } };
store.sessionFor(recorded);
passedIn.length = 0;

const resolved = store.workspaceOf(undefined);
check("单工作区时 workspaceOf 能解析出会话", resolved !== undefined);
check(
  "记下的那个实例被原样传给 sandboxPolicy（不是重新伪造的）",
  passedIn.length >= 1 && passedIn[passedIn.length - 1] === recorded,
  `resolve 收到 ${String(passedIn.length)} 次；最后一个是同一对象: ${String(passedIn[passedIn.length - 1] === recorded)}`,
);
check(
  "解析出的会话工作目录就是记下的那个",
  resolved !== undefined && resolved.cwd === process.cwd(),
  resolved === undefined ? "未解析出会话" : resolved.cwd,
);

// ── 3. 白名单不接受未记录的目录 ──────────────────────────────────
passedIn.length = 0;
check("未记录的 cwd 被拒绝", store.workspaceOf(join(process.cwd(), "..", "somewhere-else")) === undefined);
check("未知 cwd 不触发沙箱解析", passedIn.length === 0, `触发 ${String(passedIn.length)} 次`);

// ── 4. 没有会话上下文时不该进白名单 ──────────────────────────────
const store2 = new NovelStore(ctx, config);
store2.sessionFor(undefined);
check(
  "process.cwd() 兜底不进白名单（否则会去读没人用过的工作区，或把单工作区解析打掉变 403）",
  store2.workspaceOf(undefined) === undefined,
);

const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? "✓" : "✗"} ${c.name}${c.detail === undefined ? "" : `  (${c.detail})`}`);
console.log(`\n${failed.length === 0 ? "全部通过" : `${String(failed.length)} 项失败`}：${String(checks.length)} 项检查`);
process.exit(failed.length === 0 ? 0 : 1);
