/**
 * 守卫用例：解析结果必须自证属于运行中的 harness。
 *
 * 为什么单独一个脚本：这条行为要在「有旧副本、但没有任何 harness 安装」的干净环境里验证，
 * 所以它必须自己起子进程并清掉 DSH_* 环境变量——不能跑在 tests/verify.mjs 里（那里已经
 * 加载了真 harness）。
 *
 * 用法：npm run test:guard
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findInstall } from "./dsh-node-launcher.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const pluginPath = join(repoRoot, "lib", "index.js");
const fixture = join(repoRoot, "tests", "fixtures", "stale-harness.mjs");

if (!existsSync(pluginPath)) {
  console.error(`找不到插件产物：${pluginPath}\n先跑 npm run build。`);
  process.exit(1);
}

// 用 DSH 的 Electron Node（asar 里的 harness 才读得到）；找不到就退回当前 node——
// 这条用例本身不加载真 harness，两条路都成立。
const install = findInstall();
const executable = install === undefined ? process.execPath : join(install, "DeepSeek Harness.exe");
const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
// 关键：清掉指向真 harness 的环境，让「旧副本」成为唯一可解析的结果
delete env.DSH_HOME;
delete env.DSH_ENTRY;
delete env.DSH_INSTALL;

const workdir = mkdtempSync(join(tmpdir(), "nn-guard-"));
const result = spawnSync(executable, [fixture, pluginPath], {
  cwd: workdir,
  stdio: "inherit",
  env,
});

console.log(`\n守卫用例：${result.status === 0 ? "通过" : "失败"}`);
process.exit(result.status ?? 1);
