/**
 * 验证「章节 id 不能当路径段使」这道闸（安全项，必须有测试钉住）。
 *
 * 洞的形状（独立审查发现）：`chapterFile = <dataDir>/projects/<pid>/chapters/<id>.md`，
 * 而 `<id>` 直接来自 `chapters/index.json`。索引是**给人手改的普通文件**，
 * 把某条改成 `{"id":"../../other-novel/abc"}` 就能：
 *   - 通过 `/api/novel.chapter?chapter=../../other-novel/abc` 读到**另一个作品**的正文；
 *   - `../../../../Users/<u>/notes` 读到工作区外任意 `*.md`；
 *   - 同一个 id 还流进 `deleteChapter`——`assertInsideWorkspace` 只挡工作区**外**，
 *     `../other-novel/x` 在工作区内，会真的删掉别的作品。
 *
 * 修法：读索引时统一校验 id（`^[A-Za-z0-9_$.-]+$`，且不是 `.`/`..`），不合规即报错并点名。
 * 本探针用**真实 fs-local** + 内存桩 fs 服务复现：合法 id 能读到，越界 id 被拦。
 *
 * 必须用 DSH 自带的 Electron Node 运行。
 */
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rmSync } from "node:fs";
import { build } from "esbuild";
import { load, registerHarnessHook } from "./harness-loader.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
registerHarnessHook(repo);

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail: ok ? undefined : detail });

const { Context } = await load("@deepseek-ai/cordis");

// ── 内存桩 fs：只挂数据目录，记录所有路径访问 ────────────────────
const files = new Map();
let projectId = "my-novel";

function store(rel, content) {
  files.set(rel.replace(/\\/g, "/"), content);
}

function refresh() {
  projectId = "my-novel";
  files.clear();
  store(".novelnovel/projects/my-novel/project.json", JSON.stringify({ id: projectId, title: "我的小说" }));
  store(".novelnovel/projects/my-novel/chapters/index.json", JSON.stringify({ items: indexItems }));
  store(".novelnovel/projects/my-novel/chapters/c1.md", "第一章正文");
  store(".novelnovel/projects/other-novel/chapters/abc.md", "别的作品的正文，不该被读到");
  store("notes.md", "工作区外的笔记，不该被读到");
}

let indexItems = [];

const dirs = new Set([".novelnovel", ".novelnovel/projects", ".novelnovel/projects/my-novel", ".novelnovel/projects/my-novel/chapters"]);

const fsStub = {
  async resolve(path, opts = {}) {
    if (typeof path !== "string") throw new Error("bad path");
    const cwd = opts.cwd ?? process.cwd();
    // 用真实 path 语义归一化，保证 ../ 的行为与真实运行时一致
    return { mode: "local", path: resolvePath(cwd, path) };
  },
  processPath(target) {
    return target.path;
  },
  async stat(target) {
    const rel = relOf(target.path);
    if (files.has(rel)) return { type: "file", size: files.get(rel).length };
    if (dirs.has(rel)) return { type: "directory" };
    return undefined;
  },
  async readText(target) {
    const rel = relOf(target.path);
    if (!files.has(rel)) throw Object.assign(new Error(`cannot read "${target.path}": not found`), { code: "FS_NOT_FOUND" });
    return files.get(rel);
  },
  async listDir(target) {
    const rel = relOf(target.path);
    const prefix = rel === "" ? "" : `${rel}/`;
    const out = [];
    for (const key of [...files.keys(), ...dirs]) {
      if (!key.startsWith(prefix) || key === rel) continue;
      const rest = key.slice(prefix.length);
      if (rest.includes("/")) continue;
      out.push({ name: rest, type: files.has(key) ? "file" : "directory" });
    }
    return out;
  },
};

function relOf(abs) {
  const norm = abs.replace(/\\/g, "/");
  const at = norm.indexOf(".novelnovel");
  return at < 0 ? norm : norm.slice(at);
}

const ctx = new Context();
// 只提供插件真正用到的 ctx 面：`FsOps` 只调 `ctx.fs.*`，所以直接给桩即可
// （不要去 await ctx.plugin(LocalFileSystem) 再覆盖 ctx.fs：cordis 不允许跨 fiber 写服务）
ctx.provide("fs", fsStub);

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

const novel = new NovelStore(ctx, { dataDir: ".novelnovel", maxPrevChapterCount: 5, maxPrevChapterChars: 8000 });
const session = { cwd: process.cwd() };

// ── 1. 合法 id 正常读到 ─────────────────────────────────────────
indexItems = [{ id: "c1", title: "第一章", tags: [], sortOrder: 0, updatedAt: 0 }];
refresh();
{
  const chapter = await novel.readChapter(session, projectId, "c1");
  check("合法 id 正常读到正文", chapter.content === "第一章正文", JSON.stringify(chapter.content));
}

// ── 2. 越界 id：读到别的作品 ─────────────────────────────────────
indexItems = [{ id: "../../other-novel/chapters/abc", title: "偷看", tags: [], sortOrder: 0, updatedAt: 0 }];
refresh();
{
  let threw = null;
  let got = null;
  try {
    got = await novel.readChapter(session, projectId, "../../other-novel/chapters/abc");
  } catch (error) {
    threw = error;
  }
  check(
    "指向别的作品的 id 被拦下（不会读出别人的正文）",
    threw !== null && got === null,
    got === null ? undefined : `竟然读到了：${JSON.stringify(got.content)}`,
  );
  if (threw !== null) console.log(`  拦下了：${String(threw.message).split("\n")[0].slice(0, 120)}`);
}

// ── 3. 越界 id：工作区外的文件 ───────────────────────────────────
indexItems = [{ id: "../../../../notes", title: "越界", tags: [], sortOrder: 0, updatedAt: 0 }];
refresh();
{
  let threw = null;
  let got = null;
  try {
    got = await novel.readChapter(session, projectId, "../../../../notes");
  } catch (error) {
    threw = error;
  }
  check("指向工作区外的 id 被拦下", threw !== null && got === null, got === null ? undefined : "竟然读到了");
}

// ── 4. id 为 "." / ".." 也被拦 ───────────────────────────────────
for (const bad of [".", ".."]) {
  indexItems = [{ id: bad, title: "点", tags: [], sortOrder: 0, updatedAt: 0 }];
  refresh();
  let threw = null;
  try {
    await novel.readChapter(session, projectId, bad);
  } catch (error) {
    threw = error;
  }
  check(`id 为 ${JSON.stringify(bad)} 被拦下`, threw !== null, threw === null ? "没拦" : undefined);
}

// ── 5. 报错要能让人修（点名坏 id）────────────────────────────────
indexItems = [{ id: "../x", title: "坏", tags: [], sortOrder: 0, updatedAt: 0 }];
refresh();
{
  let message = "";
  try {
    await novel.readChapter(session, projectId, "../x");
  } catch (error) {
    message = String(error.message);
  }
  check('报错点名了坏 id 与修法（含 "^[A-Za-z0-9_$.-]+$"）', message.includes("../x") && message.includes("A-Za-z0-9"), message.slice(0, 140));
}

const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? "✓" : "✗"} ${c.name}${c.detail === undefined ? "" : `  (${c.detail})`}`);
console.log(`\n${failed.length === 0 ? "全部通过" : `${String(failed.length)} 项失败`}：${String(checks.length)} 项检查`);
process.exit(failed.length === 0 ? 0 : 1);
