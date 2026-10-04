// 用 DSH 自带的 Electron Node 跑「客户端半边真实组合」验证。
//
// 为什么必须借它的 Node：harness 在 app.asar 里，普通 node 读不到。
// profile 默认 novelnovel；可用 DSH_TEST_PROFILE 覆盖（与 test:dsh 同口径）。
import { fileURLToPath } from "node:url";
import { runInDshNode } from "./dsh-node-launcher.mjs";

const script = fileURLToPath(new URL("../tests/verify-client-compose.mjs", import.meta.url));
process.exit(runInDshNode(script, process.env.DSH_TEST_PROFILE ?? "novelnovel"));
