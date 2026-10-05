// 用 DSH 的 Electron Node 跑插件生命周期测试（卸载是否干净 + 能否干净重挂）
import { fileURLToPath } from "node:url";
import { runInDshNode } from "./dsh-node-launcher.mjs";

const script = fileURLToPath(new URL("../tests/verify-lifecycle.mjs", import.meta.url));
process.exit(runInDshNode(script, process.env.DSH_TEST_PROFILE ?? "novelnovel"));
