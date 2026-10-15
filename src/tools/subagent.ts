/**
 * 委派一次性子 agent 的共用部分（第 4 步的机制层）。
 *
 * 三条实测约束（都写进了 src/contract.ts 的契约说明，改这里之前先读那段）：
 *   1. **没有"持久后台 agent"**。DSH 只有 `ctx.subagents.start(provider, request)` 这种
 *      一次性 run：起一个子会话、跑一轮、拿结构化结果、销毁。所以要记账就再起一个。
 *   2. `request.parent` 必须是**活的 Agent**（工具里的 `exec.agent`）。拿不到就诚实地失败。
 *   3. `run.result` **从不 reject**：失败信息在 `stopReason` / `diagnostic` 里，
 *      判"有没有结论"要看 `structured` 在不在，而不是等它抛。
 *
 * 设计口径（用户拍板）：**只判定、只给建议，写权留在前台**；`toolFilter: { allow: [] }`
 * 把子 agent 的全局工具全部收掉（技能也加载不了），它唯一的工具是 provider 自己挂的
 * `structured_output`；`persona` 再把它的角色说清楚。
 * 为什么用 `allow: []` 而不是逐个 `deny`：`tools.restrict()` **点名不存在的工具会直接抛错**，
 * 硬编码的工具清单在别的 profile 上（少一个工具行）就会把整条链路弄挂。
 */
import type { SubagentsService, ToolRunContext } from "../contract";
import type { NovelConfig } from "../store";

/**
 * 委派真正需要的东西：**只取这两个**，不传整个 ToolDeps——
 * 这层不做任何业务读写，收窄依赖能让"子 agent 有写权"这类改动一眼可见。
 */
export interface SubagentDeps {
  config: NovelConfig;
  subagents(): SubagentsService | undefined;
}

export type SubagentOutcome =
  /** 这个组合里没有 subagents 服务：调用方要如实说明，**计入"未做语义检查"** */
  | { kind: "unavailable"; reason: string }
  /** 服务在、但这一趟没拿到可用结论（起不来 / 报错 / 空返回 / 坏形状） */
  | { kind: "failed"; reason: string }
  | { kind: "ok"; structured: unknown; text: string };

export interface SubagentSpec {
  label: string;
  prompt: string;
  /** 子 agent 的角色说明（注册成它自己作用域里的 persona 段） */
  persona: string;
  /** 标准 JSON Schema（object 根）：provider 会给子 agent 挂 `structured_output` */
  outputSchema: Record<string, unknown>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `result.output` 是内容块数组；文本兜底解析要用它拼出整段回答 */
function outputText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((block) => {
      if (typeof block === "string") return block;
      if (typeof block === "object" && block !== null && "text" in block) {
        const text = (block as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * 起一个只读的一次性子 agent 并等它的结构化结论。
 *
 * **不做任何写入**：拿不到结论就原样把原因交回调用方，由它决定是降级还是报错。
 */
export async function runStructuredSubagent(
  deps: SubagentDeps,
  exec: ToolRunContext,
  spec: SubagentSpec,
): Promise<SubagentOutcome> {
  const subagents = deps.subagents();
  if (!subagents) {
    return {
      kind: "unavailable",
      reason:
        "this composition has no `subagents` service, so the semantic check cannot run " +
        "(load @deepseek-ai/dsh-subagent, or keep using the local checks only)",
    };
  }
  const parent = exec.agent;
  if (!parent) {
    return { kind: "failed", reason: "the calling agent is unknown, so nothing can be delegated to" };
  }
  if (exec.signal.aborted) {
    return { kind: "failed", reason: "the call was cancelled before the sub-agent started" };
  }
  let provider: string;
  try {
    const providers = subagents.list();
    // 优先 spawn（干净的子上下文）：自检要判的是"这份材料对不对"，不需要继承会话历史
    provider = providers.includes("spawn") ? "spawn" : (providers[0] ?? "");
  } catch (error: unknown) {
    return { kind: "failed", reason: `could not list sub-agent providers: ${message(error)}` };
  }
  if (!provider) {
    return { kind: "failed", reason: "no sub-agent provider is registered in this composition" };
  }

  const agentOptions: { provider?: string; model?: string } = {};
  if (deps.config.reviewProvider) agentOptions.provider = deps.config.reviewProvider;
  if (deps.config.reviewModel) agentOptions.model = deps.config.reviewModel;

  let run;
  try {
    run = await subagents.start(provider, {
      label: spec.label,
      prompt: [{ type: "text", text: spec.prompt }],
      parent,
      signal: exec.signal,
      persona: spec.persona,
      toolFilter: { allow: [] },
      outputSchema: spec.outputSchema,
      ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
    });
  } catch (error: unknown) {
    return { kind: "failed", reason: `could not start the sub-agent: ${message(error)}` };
  }

  try {
    const result = await run.result;
    const text = outputText(result.output);
    if (result.structured === undefined && !text.trim()) {
      const stop = result.stopReason ?? "unknown";
      return {
        kind: "failed",
        reason:
          `the sub-agent produced no conclusion (stopReason=${stop})` +
          (result.diagnostic ? `: ${result.diagnostic}` : ""),
      };
    }
    // 结构化输出优先；没有就把整段回答交给解析层去抠 JSON
    return { kind: "ok", structured: result.structured ?? text, text };
  } catch (error: unknown) {
    return { kind: "failed", reason: `the sub-agent failed: ${message(error)}` };
  } finally {
    // 释放失败不影响已经拿到的结论（子会话已经跑完）
    try {
      await run.dispose();
    } catch {
      // 忽略
    }
  }
}
