/**
 * 并发交错的**覆盖式**测试。
 *
 * 为什么单独立一个文件：`npm run test:dsh` 里的断言都是"调一次、看结果"，而 CAS 的正确性只能
 * 用**交错**证明——A 读到基准之后、写入之前，让 B 完整跑一遍，然后看 A 是失败重试还是静默覆盖。
 * 这些修复此前只经过时序推导，没有测试能证明 CAS 真的挡住了，所以这里补上。
 *
 * 手法：把 `ctx.fs` 的读方法包一层钩子，在"第 N 次读到某文件之后"挂住，期间驱动另一个调用，
 * 再放行。判断标准统一是「**两边的编辑都要活下来**」——静默覆盖会让其中一个消失。
 *
 * 必须用 DSH 自带的 Electron Node 运行。
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { load, registerHarnessHook } from "./harness-loader.mjs";

registerHarnessHook(fileURLToPath(new URL("..", import.meta.url)));

const { Context } = await load("@deepseek-ai/cordis");
const { default: SystemPrompt } = await load("@deepseek-ai/dsh-system-prompt");
const { default: ToolRuntime } = await load("@deepseek-ai/dsh-tools");
const { default: LocalFileSystem } = await load("@deepseek-ai/dsh-fs-local");
const { default: SkillRegistry } = await load("@deepseek-ai/dsh-skill");
const plugin = await load("dsh-novelnovel");

const workspace = mkdtempSync(join(tmpdir(), "nn-race-"));
mkdirSync(join(workspace, ".git"), { recursive: true });

const ctx = new Context();
await ctx.plugin(SystemPrompt);
await ctx.plugin(ToolRuntime);
await ctx.plugin(LocalFileSystem, { cwd: workspace });
await ctx.plugin(SkillRegistry);

// ── 交错钩子：第 n 次读某个文件之后挂住 ────────────────────────────
// 门要在**被测操作开始前**才注册：准备阶段（建作品、建章）自己就会读索引，
// 提前注册会让计数被那些读消耗掉，挂点就落到错的时刻上（这个错我踩过一次）。
let hooks = [];
function pauseAfterRead(match, occurrence = 1) {
  let seen = 0;
  let hit;
  const reached = new Promise((resolve) => {
    hit = resolve;
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const entry = { reached, release, match, occurrence, seen: () => seen };
  hooks.push(async (target) => {
    // Windows 的 displayPath 用反斜杠，而这里的匹配串按包内习惯写正斜杠，先归一化
    const display = String(target?.displayPath ?? "").replace(/\\/g, "/");
    if (!display.includes(match)) return;
    seen += 1;
    if (seen !== occurrence) return;
    hit();
    await gate;
  });
  return entry;
}
/** 准备阶段结束后清空门，避免旧门干扰（也让每个用例的门从零开始计数） */
function clearGates() {
  hooks = [];
}

const fs = ctx.fs;
const wrapRead = (name) => {
  const original = fs[name].bind(fs);
  fs[name] = async (target, ...rest) => {
    const result = await original(target, ...rest);
    for (const hook of hooks) await hook(target);
    return result;
  };
};
wrapRead("readText");
wrapRead("stat");

const registered = new Map();
const tools = ctx.tools;
const register = tools.register.bind(tools);
tools.register = (definition) => {
  registered.set(definition.name, definition);
  return register(definition);
};
await ctx.plugin(plugin);
await new Promise((resolve) => setTimeout(resolve, 200));

const exec = { agent: { id: "a", session: { header: { cwd: workspace } } }, signal: new AbortController().signal };
const call = (name, args) =>
  registered.get(name).execute({ ...args }, exec).then(
    (result) => ({ ok: true, result }),
    (error) => ({ ok: false, error }),
  );

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

const created = await call("novel_project", { action: "create", title: "交错" });
const projectId = created.result?.details?.project_id;
check("准备：建好一个作品", typeof projectId === "string", String(projectId));

// ── 用例 1：两个并发 updateProject 必须都活下来 ────────────────────
// 曾经的 bug：writeJson 不传 basis → 写入前 stat 现取版本 → CAS 恒通过 → 后写者把先写者抹掉。
{
  clearGates();
  const gate = pauseAfterRead("project.json", 1);
  const first = call("novel_project", { action: "update", worldbuilding: "世界观由 A 写入" });
  await gate.reached;
  // A 已经读到基准、还没写：此刻让 B 完整跑完
  const second = await call("novel_project", { action: "update", author_note: "写作要求由 B 写入" });
  check("交错：B 的更新成功", second.ok === true, second.ok ? "" : String(second.error?.message));
  gate.release();
  const firstResult = await first;
  check("交错：A 的更新最终成功（CAS 冲突要重试而不是失败）", firstResult.ok === true, firstResult.ok ? "" : String(firstResult.error?.message));

  const raw = JSON.parse(readFileSync(join(workspace, ".novelnovel", "projects", projectId, "project.json"), "utf8"));
  check("交错后 A 的 worldbuilding 还在", raw.worldbuilding === "世界观由 A 写入", JSON.stringify(raw.worldbuilding));
  check("交错后 B 的 authorNote 还在", raw.authorNote === "写作要求由 B 写入", JSON.stringify(raw.authorNote));
}

// ── 用例 2：并发改索引时双方的改动都要活下来 ──────────────────────
// 设计意图：`moveChapter` 曾把 payload 与 CAS 基准**分成两次读**，于是"解析之后、payload 读之前"
// 别人写进去的改动会被 payload 那份旧列表整段覆盖，而基准是最新的、CAS 照样通过。
//
// **诚实标注**：这条用例证明的是"修复后并发改名 + 移动能同时存活"，但**没能证明它会抓住旧 bug**——
// 我按六种挂点构造（1 门 / 2 门 / 不同 occurrence）逐一试过，退回旧实现后它仍然通过，
// 原因是工具层的读次数与挂点计数耦合，挂点稳定地落在 payload 读**之后**。
// 也就是说：这条是回归防护，不是"曾经失败过"的证据。真正的证据在用例 1（那个我验证过会失败）。
{
  await call("novel_chapter", { action: "create", title: "第一章", text: "正文一" });
  await call("novel_chapter", { action: "create", title: "第二章", text: "正文二" });

  // 门在**准备完成之后**才注册：建章的两次调用自己就会读索引，提前注册会把计数吃掉。
  clearGates();
  const afterPayload = pauseAfterRead("chapters/index.json", 3);

  const moving = call("novel_chapter", { action: "move", chapter: "2", target: "1" });
  await afterPayload.reached;
  // A 已经拿到 payload（旧列表），但还没读基准、更没写：此刻让 B 完整跑完一次改名
  const renaming = await call("novel_chapter", { action: "rename", chapter: "2", title: "第二章（改过）" });
  check("交错：B 的改名成功", renaming.ok === true, renaming.ok ? "" : String(renaming.error?.message));
  afterPayload.release();
  const moved = await moving;
  check("交错：移动最终成功", moved.ok === true, moved.ok ? "" : String(moved.error?.message));

  const index = JSON.parse(
    readFileSync(join(workspace, ".novelnovel", "projects", projectId, "chapters", "index.json"), "utf8"),
  );
  const titles = index.items.map((item) => item.title);
  check("交错后 B 的改名还在（没有被 A 的旧列表回滚）", titles.includes("第二章（改过）"), JSON.stringify(titles));
  check("交错后两章都在", titles.length === 2, JSON.stringify(titles));
  check(
    "交错后 A 的移动也生效（第二章排到了第一章前面）",
    index.items[0]?.title === "第二章（改过）",
    JSON.stringify(titles),
  );
}

// ── 用例 3：覆写正文时，基准读之后落地的外部改动要被发现 ───────────
// `writeChapterBody` 现在在没给基准时**自己先读一次**（把"读-改-写"窗口从两次工具调用之间
// 收进一次调用内）。这条用例对准那一次读：在它之后、写入之前直接改盘上的正文，
// 于是 CAS 必须发现冲突——要么抛错要求重读，要么重试后覆盖，但**不能**在"以为自己读的是最新"
// 的前提下写下去还说成功。
//
// 诚实标注：这不覆盖"跨两次工具调用"的窗口（模型 read 之后、write 之前有人改文件）——
// 那个窗口模型看不到版本号，收不掉，属于已知缺口（AGENTS.md「还没做」里有 `action=write` 无历史）。
{
  const bodyPath = join(workspace, ".novelnovel", "projects", projectId, "chapters");
  const index = JSON.parse(readFileSync(join(bodyPath, "index.json"), "utf8"));
  const first = index.items.find((item) => item.title === "第一章");
  const bodyFile = join(bodyPath, `${first.id}.md`);

  clearGates();
  // 第 1 次读这个正文文件就是 writeChapterBody 自取基准的那一次
  const gate = pauseAfterRead(`chapters/${first.id}.md`, 1);
  const overwrite = call("novel_chapter", {
    action: "write",
    chapter: first.id,
    text: "覆写后的正文",
  });
  await gate.reached;
  // 基准已读取、写入尚未发生：此刻让"别人"改盘上的文件
  writeFileSync(bodyFile, "外部编辑写进去的内容", "utf8");
  gate.release();
  const result = await overwrite;
  const after = readFileSync(bodyFile, "utf8");
  // 关键事实：**外部改动没有被静默覆盖**。修好之前这里会写成功、内容被换掉（终态是覆写后的文本），
  // 调用方毫不知情；现在它明确失败并要求重读。
  check(
    "外部改动没有被静默覆盖",
    result.ok === false && after.includes("外部编辑写进去的内容"),
    result.ok ? `竟然写成功了，终态=${JSON.stringify(after.slice(0, 30))}` : "已拒绝且内容保留",
  );
  check(
    "拒绝时给出可执行的下一步（重读再写）",
    /changed on disk|re-read|read the chapter again/i.test(String(result.error?.message ?? "")),
    String(result.error?.message ?? "").slice(0, 110),
  );
}

rmSync(workspace, { recursive: true, force: true });
console.log(`\n${failed === 0 ? "全部通过" : `${String(failed)} 项失败`}：${String(passed + failed)} 项检查`);
process.exit(failed === 0 ? 0 : 1);
