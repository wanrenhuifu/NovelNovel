// 用 DSH 的 Electron Node 跑"产物真的能跑起来"测试（执行 lib/client.js 并调 apply）
import { fileURLToPath } from "node:url";
import { runInDshNode } from "./dsh-node-launcher.mjs";

const script = fileURLToPath(new URL("../tests/verify-client-bundle-runs.mjs", import.meta.url));
process.exit(runInDshNode(script, process.env.DSH_TEST_PROFILE ?? "novelnovel"));
