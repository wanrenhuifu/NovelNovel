// 在 DSH 自带 Electron Node 里跑 tests/perf-probe.mjs（性能探针）。
//
// 用法：
//   npm run test:perf                        # 自动探测 DSH 安装，profile 用 novelnovel
//   DSH_TEST_PROFILE=web npm run test:perf
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { runInDshNode } from "./dsh-node-launcher.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const profileName = process.env.DSH_TEST_PROFILE ?? "novelnovel";

process.exit(runInDshNode(join(repoRoot, "tests", "perf-probe.mjs"), profileName));
