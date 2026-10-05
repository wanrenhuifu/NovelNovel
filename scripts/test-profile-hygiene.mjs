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

console.log("--- 动态：**每一个装了插件的 profile** 跑完都不该多出数据目录 ---");
{
  const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  const profilesRoot = join(dshHome, "profiles");
  // 为什么要遍历而不是只看默认那个：本机 `desktop` 与 `novelnovel` 都装了插件，
  // 而**用户的会话跑在 desktop**、全部测试默认跑 novelnovel。
  // 只看一个的话，"只在另一个 profile 下发生"的问题永远测不到。
  const wanted = (process.env.DSH_TEST_PROFILES ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");

  const installed = existsSync(profilesRoot)
    ? readdirSync(profilesRoot).filter((name) => {
        const manifest = join(profilesRoot, name, "package.json");
        if (!existsSync(manifest)) return false;
        try {
          return readFileSync(manifest, "utf8").includes("dsh-novelnovel");
        } catch {
          return false;
        }
      })
    : [];
  const targets = wanted.length > 0 ? wanted : installed;
  check(
    `发现 ${String(targets.length)} 个装了插件的 profile`,
    targets.length > 0,
    targets.join(", ") || "一个都没有（插件还没装？）",
  );

  for (const profileName of targets) {
    const profileDir = join(profilesRoot, profileName);
    const before = readdirSync(profileDir).filter((name) => name.startsWith(".novelnovel"));
    // 跑一个会落盘的 e2e（它自己用临时 workspace），只关心"有没有往 profile 里写"
    let e2eOk = true;
    try {
      execFileSync("npm", ["run", "test:dsh"], {
        cwd: repo,
        stdio: "pipe",
        shell: process.platform === "win32",
        env: { ...process.env, DSH_TEST_PROFILE: profileName },
      });
    } catch {
      e2eOk = false;
    }
    const after = readdirSync(profileDir).filter((name) => name.startsWith(".novelnovel"));
    check(
      `[${profileName}] 跑完 test:dsh 后没有 .novelnovel* 残留`,
      after.length === 0,
      after.length > 0 ? `残留: ${after.join(", ")}（改动前有 ${String(before.length)} 个）` : "",
    );
    // 顺带记录：这个 profile 上的 e2e 是否真的能跑通（"用户实际那个 profile 是好的"这条要有证据）
    check(
      `[${profileName}] 这个 profile 上 e2e 跑通（插件真的装在这里并可用）`,
      e2eOk,
      e2eOk ? "" : "e2e 失败——插件在这个 profile 里可能没装好",
    );

    // 客户端半边：用**宿主真实注册表**在这个 profile 下验证组合。
    // 这是曾经导致"所有客户端插件都加载不出来"的那条路径，所以每个 profile 都要过一遍。
    let composeOk = true;
    let composeOut = "";
    try {
      composeOut = execFileSync("npm", ["run", "test:compose"], {
        cwd: repo,
        stdio: "pipe",
        shell: process.platform === "win32",
        env: { ...process.env, DSH_TEST_PROFILE: profileName },
        encoding: "utf8",
      });
    } catch (error) {
      composeOk = false;
      composeOut = String(error?.stdout ?? "");
    }
    check(
      `[${profileName}] 客户端半边能组合（缺产物会让所有客户端插件都加载不出来）`,
      composeOk,
      composeOk ? "" : composeOut.split("\n").filter((l) => l.trim()).slice(-3).join(" | "),
    );
  }
}

console.log(`\n${failed === 0 ? "全部通过" : `${String(failed)} 项失败`}：${String(passed + failed)} 项检查`);
process.exit(failed === 0 ? 0 : 1);
