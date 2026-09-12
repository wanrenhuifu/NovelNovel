// 在某个 dsh profile 里跑 tests/verify.mjs。
//
// 为什么不能在仓库根直接跑：插件的 @deepseek-ai/* 依赖由 profile 的 node_modules
// 提供（见 dsh-plugin/README.md 的安装说明），而 Node 的 ESM 解析基于文件位置。
// 所以这里切换 cwd 到 profile 目录再启动验证脚本。
//
// 用法：
//   npm run test:dsh                      # 默认 profile: novelnovel
//   DSH_PROFILE=web npm run test:dsh      # 指定 profile
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const profileName = process.env.DSH_PROFILE ?? "novelnovel";
const profileDir = join(dshHome, "profiles", profileName);
const verifyScript = join(repoRoot, "tests", "verify.mjs");

if (!existsSync(verifyScript)) {
  console.error(`找不到验证脚本：${verifyScript}`);
  process.exit(1);
}
if (!existsSync(profileDir)) {
  console.error(
    [
      `dsh profile "${profileName}" 不存在：${profileDir}`,
      "先构建并安装插件，然后重跑：",
      "  npm run build",
      `  dsh plugin --profile ${profileName} add ${repoRoot}`,
    ].join("\n"),
  );
  process.exit(1);
}

const result = spawnSync(process.execPath, [verifyScript], {
  cwd: profileDir,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
