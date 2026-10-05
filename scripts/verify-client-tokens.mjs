// 用 DSH 的 Electron Node 跑「CSS 变量是否真实存在」校验（主题产物在 app.asar 里）
import { fileURLToPath } from "node:url";
import { runInDshNode } from "./dsh-node-launcher.mjs";

const script = fileURLToPath(new URL("../tests/verify-client-tokens.mjs", import.meta.url));
process.exit(runInDshNode(script, process.env.DSH_TEST_PROFILE ?? "novelnovel"));
