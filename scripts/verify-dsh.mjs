// 在 DSH 自带 Electron Node 里跑 tests/verify.mjs（端到端验证）。
//
// 用法：
//   npm run test:dsh                        # 自动探测 DSH 安装，profile 用 novelnovel
//   DSH_INSTALL="D:\DSH" npm run test:dsh   # 指定安装目录
//   DSH_TEST_PROFILE=web npm run test:dsh   # 指定装了插件的 profile
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { runInDshNode } from "./dsh-node-launcher.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
// 插件装在哪个 profile 是仓库的测试前置，不是会话状态：会话里常带的 DSH_PROFILE=desktop
// 会让这里切到桌面端 profile，所以只认专用变量。
const profileName = process.env.DSH_TEST_PROFILE ?? "novelnovel";

process.exit(runInDshNode(join(repoRoot, "tests", "verify.mjs"), profileName));
