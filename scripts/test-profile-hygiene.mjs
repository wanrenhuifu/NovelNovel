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
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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

    // 清单不变量：**装在这个 profile 里的那份包**，`dsh.client` 与 `exports["./client"]`
    // 指向的产物必须是**同时成立**的。那是唯一能让**所有**客户端插件（含首方 UI）
    // 一起加载不出来的形态（宿主 ClientModuleRegistry 构造期同步抛），所以这条要跟着 profile 走：
    // 光看仓库里的 `npm test` 不够——被装进去的那一份才是运行时会读到的那一份。
    // （曾经这里钉的是「不许声明 dsh.client」。现在面板回来了，不变量的**形状**没变：
    //   声明与产物必须同时成立；只声明不产出仍然是禁区。）
    const installedManifest = join(profileDir, "node_modules", "dsh-novelnovel", "package.json");
    let clientDecl = null;
    let manifestReadable = false;
    let installedPkg = null;
    if (existsSync(installedManifest)) {
      try {
        installedPkg = JSON.parse(readFileSync(installedManifest, "utf8"));
        clientDecl = installedPkg.dsh?.client ?? null;
        manifestReadable = true;
      } catch {
        manifestReadable = false;
      }
    }
    check(
      `[${profileName}] profile 里那份包的清单可读`,
      manifestReadable,
      manifestReadable ? "" : `读不到或解析失败：${installedManifest}`,
    );

    if (manifestReadable && clientDecl !== null) {
      const exported = installedPkg.exports?.["./client"];
      const rel = typeof exported === "string" ? exported : exported?.default;
      const hasExport = typeof rel === "string" && rel !== "";
      check(
        `[${profileName}] 声明了 dsh.client 就有 exports["./client"]`,
        hasExport,
        hasExport ? "" : '宿主抛 declares dsh.client but exports no "./client" bundle',
      );
      if (hasExport) {
        // 相对**安装后的包目录**解析（link: 安装时它指向工作树，正是运行时会读的那份）
        const bundle = join(dirname(installedManifest), rel);
        const size = existsSync(bundle) ? statSync(bundle).size : 0;
        check(
          `[${profileName}] client 产物真实存在且非空`,
          size > 0,
          size > 0 ? `${rel} ${String(size)} 字节` : `缺 ${bundle}——宿主抛 MissingClientBundleError，整个前端一起挂`,
        );
      }
    }
  }
}

console.log(`\n${failed === 0 ? "全部通过" : `${String(failed)} 项失败`}：${String(passed + failed)} 项检查`);
process.exit(failed === 0 ? 0 : 1);
