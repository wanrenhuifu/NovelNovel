/**
 * 客户端半边的**真实组合**验证：用宿主自己的 ClientModuleRegistry 挂载本插件。
 *
 * 为什么必须有这一条：在 `package.json` 里声明 `dsh.client` 而产物缺失时，
 * 注册表构造会聚合抛出 `ClientPackageCompositionError`，导致 `/plugins` 路由不存在、
 * **整个前端**（含首方插件）加载不出来——不是「插件自己的问题」，是启动即崩。
 * 静态检查（test-client-manifest.mjs）复刻的是规则，这里跑的是**真品**：
 * 规则一旦随上游变化，静态复刻会失真，这条不会。
 *
 * 运行方式：必须用 DSH 自带的 Electron Node（harness 在 app.asar 里），
 * 所以由 scripts/verify-client-compose.mjs 启动，不要直接 node 跑。
 *
 * 两个不显然的点（别"顺手修掉"）：
 *  - loader 桩的 baseUrl 必须落在 **profile 目录**：注册表走
 *    `createRequire(baseUrl).resolve("<包名>/package.json")` 兜底，而 `link:` 安装的
 *    插件只在那里的 node_modules 可见。
 *  - 产物 URL 是 **combo** 形状（`/plugins/??<包名>/client.js&rev=<rev>`），
 *    单条目也走 combo；`/plugins/<包名>/client.js?rev=…` 只服务包内 chunk，会 404。
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { harnessRoot, load, registerHarnessHook } from "./harness-loader.mjs";

registerHarnessHook(fileURLToPath(new URL("..", import.meta.url)));

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail: ok ? undefined : detail });

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
const packageName = pkg.name;
const declared = pkg.dsh?.client !== undefined;

if (!declared) {
  console.log("本包未声明 dsh.client（纯宿主插件），跳过组合验证。");
  process.exit(0);
}

console.log(`harness: ${harnessRoot()}`);

const { Context } = await load("@deepseek-ai/cordis");
const ClientModules = (await load("@deepseek-ai/dsh-client-modules")).default;

// 真实运行时的解析基准：active profile 目录（`link:` 安装的插件在那里可见）
const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? "", ".dsh");
const profile = process.env.DSH_TEST_PROFILE ?? "novelnovel";
const baseUrl = join(dshHome, "profiles", profile, "anchor.mjs");

try {
  const resolved = createRequire(baseUrl).resolve(`${packageName}/package.json`);
  check("插件包在 profile 里可解析", true);
  console.log(`  包解析到 ${resolved}`);
} catch (error) {
  check("插件包在 profile 里可解析", false, `${error.code ?? error.message}（先把它装进 profile）`);
}

const loaderStub = {
  entries() {
    const entry = this._entry;
    return entry === undefined ? [] : [entry];
  },
  _entry: {
    options: { name: packageName },
    fiber: {},
    disabled: false,
    parent: { tree: { ctx: { baseUrl } } },
  },
};

const ctx = new Context();
ctx.provide("loader", loaderStub);

// 挂载本身就是最强的断言：任何客户端包组合失败都会在这里聚合抛出
let mounted = true;
let mountError;
try {
  await ctx.plugin(ClientModules);
} catch (error) {
  mounted = false;
  mountError = error;
}
check(
  "ClientModuleRegistry 挂载成功（组合无失败项）",
  mounted,
  mountError === undefined
    ? undefined
    : `${mountError.constructor?.name ?? "Error"}: ${String(mountError.message).split("\n").slice(0, 5).join(" / ")}`,
);

if (mounted) {
  const graph = ctx.clientModules.graph();
  const ids = graph.entries.map((entry) => entry.id);
  check("boot graph 含本包", ids.includes(packageName), `实际: ${ids.join(", ") || "(空)"}`);

  const clientPath = ctx.clientModules.clientPath(packageName);
  check(
    "clientPath 指向本仓库产物",
    typeof clientPath === "string" && clientPath.replace(/\\/g, "/").endsWith("/lib/client.js"),
    String(clientPath),
  );

  const row = graph.entries.find((entry) => entry.id === packageName);
  check("产生了 combo 描述", row !== undefined);
  const batches = graph.batches.filter((batch) => batch.entries.includes(packageName));
  check("被排进某个启动批次", batches.length === 1, `命中 ${String(batches.length)} 个批次`);
  check(
    "排进 application 批次（解析器引导包之外）",
    batches.every((batch) => batch.phase === "application"),
    batches.map((batch) => batch.phase).join(", "),
  );

  if (row !== undefined) {
    // 端到端：注册表自己把产物吐出来——这正是浏览器会拿到的东西
    const url = `/plugins/??${row.id}/client.js&rev=${row.rev}`;
    try {
      const response = await ctx.clientModules.fetchBundle(new Request(`http://127.0.0.1:19387${url}`));
      const body = await response.text();
      check("注册表能服务产物（200 + JS）", response.status === 200 && body.length > 0, `status=${String(response.status)}`);
      check(
        "服务的字节是 __ModuleLoader__ 包装",
        body.startsWith("window.__ModuleLoader__.load({"),
        body.slice(0, 40),
      );
    } catch (error) {
      check("注册表能服务产物（200 + JS）", false, String(error.message));
    }
  }
}

const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? "✓" : "✗"} ${c.name}${c.detail === undefined ? "" : `  (${c.detail})`}`);
console.log(`\n${failed.length === 0 ? "全部通过" : `${String(failed.length)} 项失败`}：${String(checks.length)} 项检查`);
process.exit(failed.length === 0 ? 0 : 1);
