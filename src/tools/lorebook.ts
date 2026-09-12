/**
 * novel_lorebook：世界观词条的维护。
 * 词条分两类：带关键词的仅在关键词出现在续写上下文里时注入；无关键词的常驻注入。
 */
import type { LorebookPatch } from "../store";
import { lines, preview, requireFields, TEXT_OUTPUT, textRender, type ToolDeps } from "./shared";

export function registerLorebookTool({ ctx, store, defineTool }: ToolDeps): void {
  ctx.tools.register(
    defineTool({
      name: "novel_lorebook",
      description: lines(
        "Maintain the world-setting (lorebook) entries of a novel project.",
        "An entry with comma-separated `keys` is injected into the writing brief only when one of those keywords appears in the current context;",
        "an entry without keys is always injected (use it for core world rules).",
        "SillyTavern cards merged their embedded world book here automatically on import.",
      ),
      parameters: {
        action: {
          type: "string",
          required: true,
          enum: ["list", "add", "update", "remove"],
          description: "What to do.",
        },
        project: {
          type: "string",
          description: "Project id, title, or 1-based index. Defaults to the current project.",
        },
        entry: {
          type: "string",
          description: "Entry id or name (exact or unique partial). Required for update/remove.",
        },
        name: { type: "string", description: "Entry name (action=add/update)." },
        keys: {
          type: "string",
          description:
            "Comma-separated trigger keywords, e.g. 血月, 祭司. Empty means the entry is always injected.",
        },
        content: { type: "string", description: "Entry text: the setting to inject." },
        enabled: {
          type: "boolean",
          description: "Whether the entry may be injected. Defaults to true when adding.",
        },
        toggle: {
          type: "boolean",
          description: "Set true to flip the entry's enabled state (action=update).",
        },
      },
      output: { schema: TEXT_OUTPUT, render: textRender },
      isConcurrencySafe: (args) => args.action === "list",
      async execute(args, exec) {
        const session = store.sessionOf(exec);
        const projectId = await store.resolveProjectId(session, args.project);

        if (args.action === "list") {
          const entries = await store.readLorebook(session, projectId);
          const always = entries.filter((e) => !e.keys.trim());
          const keyworded = entries.filter((e) => e.keys.trim());
          const enabled = entries.filter((e) => e.enabled);
          const summary = lines(
            entries.length === 0
              ? "The lorebook is empty. Add core world rules with novel_lorebook action=add (omit keys to always inject)."
              : `Lorebook (${entries.length} entries · ${always.length} always-on, ${keyworded.length} keyword-triggered` +
                (entries.length > enabled.length ? `, ${entries.length - enabled.length} disabled` : "") +
                "):",
            ...entries.map((entry) =>
              lines(
                `- ${entry.name} [${entry.id}]${entry.enabled ? "" : " (disabled — never injected)"}`,
                `  keys: ${entry.keys.trim() || "(always injected)"}`,
                `  ${preview(entry.content, 100)}`,
              ),
            ),
          );
          return {
            action: args.action,
            summary,
            details: {
              project_id: projectId,
              total: entries.length,
              always_on: always.length,
              keyword_triggered: keyworded.length,
              entries: entries.map((entry) => ({
                id: entry.id,
                name: entry.name,
                keys: entry.keys,
                enabled: entry.enabled,
              })),
            },
          };
        }

        if (args.action === "add") {
          if (!args.name?.trim()) throw new Error("name is required for novel_lorebook action=add");
          if (!args.content?.trim()) {
            throw new Error("content is required for novel_lorebook action=add");
          }
          const result = await store.addLoreEntries(session, projectId, [
            {
              name: args.name.trim(),
              keys: args.keys?.trim() ?? "",
              content: args.content.trim(),
              enabled: args.enabled !== false,
            },
          ]);
          return {
            action: args.action,
            summary: lines(
              result.added > 0
                ? `Added lorebook entry 「${args.name.trim()}」 — ${result.total} entries total.`
                : `Entry 「${args.name.trim()}」 already exists with identical content — nothing added.`,
            ),
            details: { project_id: projectId, added: result.added, total: result.total },
          };
        }

        if (!args.entry?.trim()) {
          throw new Error(`entry is required for novel_lorebook action=${args.action}`);
        }

        if (args.action === "remove") {
          const removed = await store.removeLoreEntry(session, projectId, args.entry);
          return {
            action: args.action,
            summary: `Removed lorebook entry 「${removed.name}」 [${removed.id}].`,
            details: { project_id: projectId, entry_id: removed.id },
          };
        }

        if (args.action === "update") {
          const patch: LorebookPatch = {};
          if (args.name !== undefined) patch.name = args.name;
          if (args.keys !== undefined) patch.keys = args.keys;
          if (args.content !== undefined) patch.content = args.content;
          if (args.enabled !== undefined) patch.enabled = args.enabled;
          if (args.toggle === true) patch.toggle = true;
          const fields = Object.keys(patch);
          requireFields(
            fields,
            "nothing to update: pass name / keys / content / enabled, or toggle=true to flip enabled",
          );
          const updated = await store.updateLoreEntry(session, projectId, args.entry, patch);
          return {
            action: args.action,
            summary: lines(
              `Updated lorebook entry 「${updated.name}」 [${updated.id}]: ${fields.join(", ")}.`,
              `  enabled: ${updated.enabled} · keys: ${updated.keys.trim() || "(always injected)"}`,
            ),
            details: {
              project_id: projectId,
              entry_id: updated.id,
              enabled: updated.enabled,
              updated: fields,
            },
          };
        }

        throw new Error(`unhandled action: ${args.action}`);
      },
    }),
  );
}
