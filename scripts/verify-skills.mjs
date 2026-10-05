// 用 DSH 的 Electron Node 跑技能路由可达性测试（中文触发词必须在 description 里）
import { fileURLToPath } from "node:url";
import { runInDshNode } from "./dsh-node-launcher.mjs";

const script = fileURLToPath(new URL("../tests/verify-skills.mjs", import.meta.url));
process.exit(runInDshNode(script, process.env.DSH_TEST_PROFILE ?? "novelnovel"));
