// 用 DSH 自带的 Electron Node 跑「客户端 import 的首方导出必须真实存在」校验。
// 必须借它的 Node：组件库产物在 app.asar 里，普通 node 读不到。
import { fileURLToPath } from "node:url";
import { runInDshNode } from "./dsh-node-launcher.mjs";

const script = fileURLToPath(new URL("../tests/verify-client-primitives.mjs", import.meta.url));
process.exit(runInDshNode(script, process.env.DSH_TEST_PROFILE ?? "novelnovel"));
