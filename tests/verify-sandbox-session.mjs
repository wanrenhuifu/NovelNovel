/**
 * 探针：交给 `ctx.sandboxPolicy.resolve` 的会话必须是**真会话实例**，不能是伪造物。
 *
 * 背景（独立审查实测出的致命 bug）：早先 Web 路由那条链路上曾用 `{ header: { cwd } }` 造了个
 * 假 Session 交进去，而真品会去读会话 projection：
 *   `TypeError: session.snapshotEvents is not a function`
 * → 调用链全部失败，而且只在运行期暴露（类型上完全合法）。
 * 现在没有 Web 路由了，但**这条约束对每个工具调用同样成立**：store 必须把 exec 里那个真
 * Session 原样透传下去。本探针用真实的 `dsh-sandbox-policy` 观察 `resolve` 收到了哪个对象。
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
  "伪造的 Session 会被真品拒绝（所以绝不能自己造一个会话对象）",
  fakeThrew !== null,
  fakeThrew === null ? "竟然没抛错——上游行为变了，本测试要重新评估" : undefined,
);
if (fakeThrew !== null) console.log(`  伪造对象的报错：${String(fakeThrew.message).split("\n")[0]}`);

// ── 2. store 把「真会话实例」原样透传 ────────────────────────────
// 这里把 resolve 换成**不碰投影的桩**：本步断言的是「store 传了哪个对象」，
// 而不是「假对象能不能当会话用」（后者不可能，也不必测）。
const passedIn = [];
ctx.sandboxPolicy.resolve = (request) => {
  passedIn.push(request?.session);
  return { mode: "read-only", workspaceRoot: process.cwd() };
};

const store = new NovelStore(ctx, config);
const realSession = { header: { cwd: process.cwd() } };
const session = store.sessionFor(realSession);

check(
  "sessionFor 把同一个会话实例交给 sandboxPolicy（不是重新伪造的）",
  passedIn.length === 1 && passedIn[0] === realSession,
  `resolve 收到 ${String(passedIn.length)} 次；最后一个是同一对象: ${String(passedIn[passedIn.length - 1] === realSession)}`,
);
check("文件会话的工作目录来自那个会话", session.cwd === process.cwd(), session.cwd);
check("有工作目录的会话不标 ephemeral（可以写）", session.ephemeral !== true, String(session.ephemeral));

// ── 3. 没有会话时走部署默认，而不是伪造一个 ──────────────────────
passedIn.length = 0;
const noSession = store.sessionFor(undefined);
check(
  "没有会话时 resolve 收到的是「无 session」请求（走部署默认）",
  passedIn.length === 1 && passedIn[0] === undefined,
  `收到 ${String(passedIn.length)} 次，第一个是 ${String(passedIn[0])}`,
);
check(
  "没有会话的 FsSession 标记为 ephemeral —— 写入闸据此拒绝落盘",
  noSession.ephemeral === true,
  JSON.stringify(noSession.ephemeral),
);

// ── 4. 空 cwd 与缺失 cwd 同样算「没有工作区」────────────────────
const emptyCwd = store.sessionFor({ header: { cwd: "" } });
check(
  'cwd 为空串也算没有工作区（dsh-tools 在缺 agent 时会合成 { header: { cwd: "" } }）',
  emptyCwd.ephemeral === true,
  JSON.stringify(emptyCwd.ephemeral),
);

const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? "✓" : "✗"} ${c.name}${c.detail === undefined ? "" : `  (${c.detail})`}`);
console.log(`\n${failed.length === 0 ? "全部通过" : `${String(failed.length)} 项失败`}：${String(checks.length)} 项检查`);
process.exit(failed.length === 0 ? 0 : 1);
