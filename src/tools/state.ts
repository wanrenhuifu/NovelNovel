/**
 * novel_state：状态层（MVU 兼容的变量树）。
 *
 * 为什么需要它：现代卡的"玩法"就是一棵变量树（时间/地点/生命/储物袋/功法…），模型每章在正文末尾
 * 输出 `<UpdateVariable><JSONPatch>…` 来推进它。插件负责：
 *   - 把正文里的协议块**剥掉**（正文只留小说），把 patch 应用到 `state.json`；
 *   - 变更写 `state-log.jsonl`（append-only，人可读，可回看"这一章改了什么"）；
 *   - 下一章把渲染后的状态**无条件**放进简报（不受预设 story_string 影响）。
 *
 * 这个工具是给人（和模型）手动查看/校正那一层状态的入口——自动更新走 `novel_chapter action=append`。
 */
import { parseUpdateBlock } from "../domain/stateUpdate";
import { lines, preview, TEXT_OUTPUT, textRender, type ToolDeps } from "./shared";

export function registerStateTool({ ctx, store, defineTool }: ToolDeps): void {
  ctx.tools.register(
    defineTool({
      name: "novel_state",
      description: lines(
        "Inspect and maintain the project's **state tree** (a.k.a. variables): time, location, HP, inventory, techniques…",
        "Normally the model advances it automatically: any `<UpdateVariable><JSONPatch>[…]</JSONPatch></UpdateVariable>`",
        "block written inside a chapter body is stripped from the prose, applied to state.json, and logged to state-log.jsonl.",
        "The rendered state is injected into every writing brief (independent of the active preset).",
        "Use this tool to look at it, seed it from an imported source (`init`), fix it by hand (`apply`/`set`), or read the log.",
      ),
      parameters: {
        action: {
          type: "string",
          required: true,
          enum: ["show", "init", "set", "apply", "log", "clear"],
          description: "What to do.",
        },
        project: {
          type: "string",
          description: "Project id, title, or 1-based index. Defaults to the current project.",
        },
        source: {
          type: "string",
          description: "action=init: source id (exact or unique partial) whose `[initvar]` seeds the tree.",
        },
        tree: {
          type: "string",
          description: 'action=set: the whole state tree as a JSON object, e.g. {"世界":{"当前时间":"未知"}}.',
        },
        patch: {
          type: "string",
          description:
            'action=apply: a JSON array of patch ops, e.g. [{"op":"replace","path":"/世界/当前时间","value":"次日清晨"}].',
        },
        limit: {
          type: "number",
          description: "action=log: how many recent entries to show (default 10, max 100).",
        },
        confirm: {
          type: "boolean",
          description: "action=clear requires true. Ask the user first.",
        },
      },
      output: { schema: TEXT_OUTPUT, render: textRender },
      isConcurrencySafe: (args) => args.action === "show" || args.action === "log",
      async execute(args, exec) {
        const session = store.sessionOf(exec);
        const projectId = await store.resolveProjectId(session, args.project);

        if (args.action === "show") {
          const { tree, updatedAt } = await store.readState(session, projectId);
          const keys = Object.keys(tree);
          const rendered = await store.stateForPrompt(session, projectId);
          return {
            action: args.action,
            summary: lines(
              keys.length === 0
                ? "The state tree is empty. Seed it with novel_state action=init source=<source> (a card's [initvar]), or set it by hand."
                : `State tree (${String(keys.length)} top-level keys${updatedAt === null ? "" : `, updated ${new Date(updatedAt).toISOString()}`}):`,
              keys.length === 0 ? null : preview(rendered, 1200),
            ),
            details: { project_id: projectId, tree, updated_at: updatedAt, keys },
          };
        }

        if (args.action === "init") {
          const wanted = args.source?.trim() ?? "";
          if (wanted === "") throw new Error("source is required for novel_state action=init");
          const sources = await store.listSources(session, projectId);
          const exact = sources.find((item) => item.id === wanted);
          const partial = sources.filter((item) => item.name.includes(wanted) || item.id.startsWith(wanted));
          const record = exact ?? (partial.length === 1 ? partial[0] : undefined);
          if (record === undefined) {
            throw new Error(
              partial.length === 0
                ? `no source matches "${wanted}"`
                : `"${wanted}" is ambiguous: ${partial.map((item) => `${item.name} [${item.id}]`).join(", ")}`,
            );
          }
          const seeded = await store.initStateFromSource(session, projectId, record.id);
          return {
            action: args.action,
            summary: `Seeded the state tree from 「${seeded.sourceName}」 (${String(seeded.keys)} top-level keys).`,
            details: { project_id: projectId, source: record.id, keys: seeded.keys, tree: seeded.tree },
          };
        }

        if (args.action === "set") {
          const raw = args.tree?.trim() ?? "";
          if (raw === "") throw new Error("tree is required for novel_state action=set (a JSON object)");
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch (error) {
            throw new Error(`tree is not valid JSON: ${(error as Error).message}`);
          }
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw new Error("tree must be a JSON object (not an array or scalar)");
          }
          const tree = parsed as Record<string, never>;
          await store.saveState(session, projectId, tree);
          return {
            action: args.action,
            summary: `Replaced the state tree (${String(Object.keys(tree).length)} top-level keys).`,
            details: { project_id: projectId, keys: Object.keys(tree) },
          };
        }

        if (args.action === "apply") {
          const raw = args.patch?.trim() ?? "";
          if (raw === "") throw new Error('patch is required for novel_state action=apply (a JSON array)');
          const block = `<JSONPatch>${raw}</JSONPatch>`;
          const parsed = parseUpdateBlock(block);
          if (parsed.error !== undefined) throw new Error(parsed.error);
          const result = await store.applyStateUpdate(session, projectId, [block], null);
          return {
            action: args.action,
            summary: lines(
              `Applied ${String(result.applied.length)} of ${String(parsed.patch.length)} operation(s).`,
              result.rejected.length === 0
                ? null
                : lines(
                    "Rejected:",
                    ...result.rejected.map((item) => `- ${item.op} ${item.path}: ${item.reason}`),
                  ),
            ),
            details: {
              project_id: projectId,
              applied: result.applied,
              rejected: result.rejected,
            },
          };
        }

        if (args.action === "log") {
          const limit = Math.min(100, Math.max(1, Math.trunc(args.limit ?? 10)));
          const entries = await store.readStateLog(session, projectId, limit);
          return {
            action: args.action,
            summary: lines(
              entries.length === 0 ? "No state changes yet." : `Last ${String(entries.length)} state change(s):`,
              ...entries.map((entry) => {
                const applied = Array.isArray(entry.applied) ? (entry.applied as unknown[]).length : 0;
                const rejected = Array.isArray(entry.rejected) ? (entry.rejected as unknown[]).length : 0;
                return `- ${String(entry.kind)}${entry.chapter === null ? "" : ` @${String(entry.chapter)}`}: ` +
                  `${String(applied)} applied${rejected > 0 ? `, ${String(rejected)} rejected` : ""}` +
                  `${typeof entry.note === "string" ? ` (${entry.note})` : ""}`;
              }),
            ),
            details: { project_id: projectId, entries },
          };
        }

        // clear
        if (args.action === "clear") {
          if (args.confirm !== true) {
            throw new Error("action=clear requires confirm=true. Ask the user before wiping the state tree.");
          }
          await store.saveState(session, projectId, {});
          return {
            action: args.action,
            summary: "Cleared the state tree.",
            details: { project_id: projectId },
          };
        }

        throw new Error(`unsupported action "${String(args.action)}"`);
      },
    }),
  );
}
