/**
 * 「测试不许污染用户 profile」的守卫。
 *
 * 背景：启动器曾把测试进程的 cwd 设成 **profile 目录**，于是一个缺会话的探针真的在
 * `~/.dsh/profiles/<name>/.novelnovel/` 里造出三本空作品——**跑测试写进了用户的 DSH 配置目录**，
 * 最后要人工确认再删。这类污染没有任何测试会失败，所以它活了很久。
 *
 * 两条判据：
 * 1. **静态**：启动器里不能出现把 cwd 指向 profile 的写法（防止有人改回去）；
 * 2. **动态**：跑一遍测试后，profile 里不该多出 `.novelnovel*` 数据目录。
 *
 * 普通 Node 即可（只读文件与目录）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
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

console.log("--- 静态：启动器不能把 cwd 设成 profile ---");
{
  const source = readFileSync(join(repo, "scripts", "dsh-node-launcher.mjs"), "utf8");
  check(
    "启动器不再出现 `cwd: profileDir`",
    !/cwd:\s*profileDir/.test(source),
    /cwd:\s*profileDir/.test(source) ? "又指回 profile 了" : "",
  );
  check("启动器给测试一个临时 cwd", /cwd:\s*scratch/.test(source), "");
  check("启动器导出 NN_TEST_CWD（测试要落盘时有已知位置）", source.includes("NN_TEST_CWD"), "");
}

console.log("--- 动态：跑测试后 profile 不该多出数据目录 ---");
{
  const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  const profileName = process.env.DSH_TEST_PROFILE ?? "novelnovel";
  const profileDir = join(dshHome, "profiles", profileName);
  if (!existsSync(profileDir)) {
    check(`profile ${profileName} 存在（不存在则跳过动态检查）`, true, "跳过");
  } else {
    const before = readdirSync(profileDir).filter((name) => name.startsWith(".novelnovel"));
    // 跑一个会落盘的 e2e（它自己用临时 workspace），只关心"有没有往 profile 里写"
    try {
      execFileSync("npm", ["run", "test:dsh"], {
        cwd: repo,
        stdio: "pipe",
        shell: process.platform === "win32",
      });
    } catch {
      // e2e 自身失败有别的测试负责；这里只判污染
    }
    const after = readdirSync(profileDir).filter((name) => name.startsWith(".novelnovel"));
    check(
      "跑完 test:dsh 后 profile 里没有 .novelnovel* 残留",
      after.length === 0,
      after.length > 0 ? `残留: ${after.join(", ")}（改动前有 ${String(before.length)} 个）` : "",
    );
  }
}

console.log(`\n${failed === 0 ? "全部通过" : `${String(failed)} 项失败`}：${String(passed + failed)} 项检查`);
process.exit(failed === 0 ? 0 : 1);
