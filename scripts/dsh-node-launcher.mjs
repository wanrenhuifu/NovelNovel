/**
 * 启动器共用部分：把测试脚本交给 DSH 自带的 Electron Node 运行。
 *
 * 为什么不能用普通 node：
 *   1. harness 包（@deepseek-ai/*）在桌面端安装里位于 app.asar 内，只有带 Electron
 *      asar 支持的进程才读得到；
 *   2. 顺手保证测试进程与运行中的 DSH 用同一套模块解析语义。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 找 DSH 安装目录：$DSH_INSTALL → 从 $DSH_ENTRY 反推 → 常见位置 */
export function findInstall() {
  const candidates = [];
  if (process.env.DSH_INSTALL) candidates.push(process.env.DSH_INSTALL);
  const marker = join("resources", "app.asar");
  if (process.env.DSH_ENTRY) {
    const at = process.env.DSH_ENTRY.indexOf(marker);
    if (at > 0) candidates.push(process.env.DSH_ENTRY.slice(0, at));
  }
  candidates.push("D:\\DSH", join("C:\\", "Program Files", "DSH Desktop"));
  return candidates.find((dir) => existsSync(join(dir, "DeepSeek Harness.exe")));
}

/**
 * 在 profile 目录里用 DSH 的 Electron Node 跑一个脚本。
 * @param script 要运行的脚本绝对路径
 * @param profileName 测试用的 profile 名（插件装在那里）
 * @returns 退出码
 */
export function runInDshNode(script, profileName) {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  const profileDir = join(dshHome, "profiles", profileName);
  if (!existsSync(script)) {
    console.error(`找不到脚本：${script}`);
    return 1;
  }
  if (!existsSync(profileDir)) {
    console.error(
      [
        `dsh profile "${profileName}" 不存在：${profileDir}`,
        "先装好插件再重跑（桌面端要完全退出后用自带 CLI）：",
        `  <DSH 安装>\\resources\\runtime\\cli\\bin\\dsh.cmd plugin --profile ${profileName} add <本仓库路径>`,
      ].join("\n"),
    );
    return 1;
  }

  const install = findInstall();
  if (install === undefined) {
    console.error(
      [
        "找不到 DSH 安装（需要 DeepSeek Harness.exe）。",
        "测试必须用 DSH 自带的 Electron Node 运行：harness 包在 app.asar 内，普通 node 读不到。",
        '指定安装目录：$env:DSH_INSTALL = "<DSH 安装目录>"',
      ].join("\n"),
    );
    return 1;
  }

  console.log(`harness: ${install}`);
  const result = spawnSync(join(install, "DeepSeek Harness.exe"), [script], {
    cwd: profileDir,
    stdio: "inherit",
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      DSH_INSTALL: install,
      // 只影响测试进程的 cwd/插件解析；会话里常带的 DSH_PROFILE 不能决定测试用哪个 profile
      DSH_PROFILE: profileName,
      DSH_ENTRY: join(install, "resources", "app.asar", "dsh", "node_modules", "anchor.mjs"),
    },
  });
  return result.status ?? 1;
}
