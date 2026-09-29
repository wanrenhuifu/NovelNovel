/**
 * 守卫用例的 fixture：在「工作树里躺着旧 harness 副本」的环境里加载插件产物，
 * 期望它**拒绝**那份副本而不是静默加载（静默加载 = 第二份 harness 实例 = 服务重复注册）。
 *
 * 用法：<DSH 的 Electron Node> tests/fixtures/stale-harness.mjs <插件产物绝对路径>
 * 输出：ok / FAIL 一行结论；退出码 0 表示行为符合预期。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const pluginPath = process.argv[2];
if (!pluginPath) {
  console.log("FAIL 用法：stale-harness.mjs <插件产物绝对路径>");
  process.exit(1);
}

// 造一份「旧副本」：版本与当前 harness 不同，且一旦被加载就会显式报错
const ws = join(process.cwd(), "stale-ws");
const stale = join(ws, "node_modules", "@deepseek-ai", "dsh-tools");
mkdirSync(join(stale, "lib"), { recursive: true });
writeFileSync(
  join(stale, "package.json"),
  JSON.stringify({ name: "@deepseek-ai/dsh-tools", version: "0.0.1-rc.1", main: "lib/index.js" }),
);
writeFileSync(
  join(stale, "lib", "index.js"),
  'export const defineTool = () => { throw new Error("STALE COPY WAS LOADED"); };\n',
);

process.chdir(ws);

try {
  await import(pathToFileURL(pluginPath).href);
  console.log("FAIL 插件加载了工作树里的旧副本（应当拒绝）");
  process.exit(1);
} catch (error) {
  const message = String(error?.message ?? error);
  if (!/could be proven to belong to the running harness/.test(message)) {
    console.log(`FAIL 报错内容与预期不符：${message.split("\n")[0]}`);
    process.exit(1);
  }
  if (!/0\.0\.1-rc\.1/.test(message)) {
    console.log("FAIL 报错没有点名那份副本的版本，排查时看不出问题出在哪");
    process.exit(1);
  }
  console.log("ok 插件拒绝了工作树里的旧 harness 副本，并给出可排查的报错");
}
