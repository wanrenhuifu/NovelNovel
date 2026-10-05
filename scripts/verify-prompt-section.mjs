// 用 DSH 的 Electron Node 跑系统提示词段测试（内容 + 卸载）
import { fileURLToPath } from "node:url";
import { runInDshNode } from "./dsh-node-launcher.mjs";

const script = fileURLToPath(new URL("../tests/verify-prompt-section.mjs", import.meta.url));
process.exit(runInDshNode(script, process.env.DSH_TEST_PROFILE ?? "novelnovel"));
