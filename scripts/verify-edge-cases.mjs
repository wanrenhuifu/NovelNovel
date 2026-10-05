// 用 DSH 的 Electron Node 跑边界回归（章节引用优先级 / keys 规范化 / confirm 闸）
import { fileURLToPath } from "node:url";
import { runInDshNode } from "./dsh-node-launcher.mjs";

const script = fileURLToPath(new URL("../tests/verify-edge-cases.mjs", import.meta.url));
process.exit(runInDshNode(script, process.env.DSH_TEST_PROFILE ?? "novelnovel"));
