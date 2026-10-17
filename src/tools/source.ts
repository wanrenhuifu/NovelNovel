/**
 * novel_source：资料源（卡 / 独立世界书）的导入与查看。
 *
 * 为什么要单独一个工具：一张现代社区卡**不是一个角色**，而是一个可运行的世界模块——实测《道渊》
 * v5.4.2 里 `character_book` 就有 356 条 / 28.7 万字，混着设定、人物档案、程序化生成规则和 MVU
 * 变量规则。把它当"一个角色"导进来，规则会跟着设定一起按关键词随机注入。
 *
 * 所以导入时**拆解 + 分类到通道**（lore/style/gameplay/state/cast/material），可注入的那些并进世界书
 * （带 source/channel），其余（状态初值、开篇剧本、状态栏模板、运行时脚本）留在源里只读——
 * 并且导入结果必须给出**拆解报告**，让人一眼看出哪条被判成了什么、什么不生效。
 *
 * 通道与状态的完整设计见 docs/design/sources-and-state.md。
 */
import { CHANNEL_LABEL, INJECTABLE_CHANNELS, type Channel } from "../domain/sourceImport";
import { lines, preview, TEXT_OUTPUT, textRender, type ToolDeps } from "./shared";

export function registerSourceTool({ ctx, store, defineTool }: ToolDeps): void {
  ctx.tools.register(
    defineTool({
      name: "novel_source",
      description: lines(
        "Import and inspect **source material** for a novel project: character cards and standalone world books.",
        "A modern community card is a whole world module (world bible, cast, procedural rules, MVU variables) — not a single character.",
        "This tool decomposes it into channels: lore (keyword-triggered), style (always-on writing guidance), gameplay (always-on rules),",
        "state (initial variable tree), cast (character profiles), material (opening script / status-bar templates / runtime scripts — never injected).",
        "Injectable channels are merged into the world book with source provenance; the rest stays in the source for inspection.",
        "Always report the decomposition to the user, especially anything that will NOT take effect.",
      ),
      parameters: {
        action: {
          type: "string",
          required: true,
          enum: ["list", "show", "import", "enable", "disable"],
          description: "What to do.",
        },
        project: {
          type: "string",
          description: "Project id, title, or 1-based index. Defaults to the current project.",
        },
        path: {
          type: "string",
          description: "action=import: path to the card (.png / .json) or world book (.json), absolute or workspace-relative.",
        },
        source: {
          type: "string",
          description: "action=show/enable/disable: source id (exact or unique partial).",
        },
      },
      output: { schema: TEXT_OUTPUT, render: textRender },
      isConcurrencySafe: (args) => args.action === "list" || args.action === "show",
      async execute(args, exec) {
        const session = store.sessionOf(exec);
        const projectId = await store.resolveProjectId(session, args.project);

        if (args.action === "list") {
          const sources = await store.listSources(session, projectId);
          if (sources.length === 0) {
            return {
              action: args.action,
              summary:
                "No sources yet. Import a character card or a world book with novel_source action=import path=<file>.",
              details: { project_id: projectId, total: 0, sources: [] },
            };
          }
          const summary = lines(
            `Sources (${String(sources.length)}):`,
            ...sources.map((source) =>
              lines(
                `- ${source.name} [${source.id}] ${source.kind === "card" ? "卡" : "世界书"}` +
                  `${source.enabled ? "" : " (disabled)"} · priority ${String(source.priority)}`,
                `  ${(Object.keys(source.counts) as Channel[])
                  .filter((channel) => source.counts[channel] > 0)
                  .map((channel) => `${CHANNEL_LABEL[channel]} ${String(source.counts[channel])}`)
                  .join(" · ")}`,
                `  from ${source.originFile}`,
              ),
            ),
          );
          return {
            action: args.action,
            summary,
            details: { project_id: projectId, total: sources.length, sources },
          };
        }

        if (args.action === "import") {
          if (!args.path?.trim()) throw new Error("path is required for novel_source action=import");
          const result = await store.importSource(session, projectId, args.path.trim());
          const summary = lines(
            `Imported ${result.record.kind === "card" ? "card" : "world book"} 「${result.record.name}」 ` +
              `[${result.record.id}] from ${result.record.originFile}`,
            ...result.report,
            `并入世界书：新增 ${String(result.merged.added)} 条、去重跳过 ${String(result.merged.skipped)} 条`,
            "提示：分类是自动判的，可能判错。用 novel_source action=show 查看每条的通道与理由。",
          );
          return {
            action: args.action,
            summary,
            details: {
              project_id: projectId,
              source: result.record,
              counts: result.record.counts,
              merged: result.merged,
              notes: result.payload.notes,
            },
          };
        }

        // show / enable / disable 都需要先定位源
        const wanted = args.source?.trim() ?? "";
        if (wanted === "") throw new Error(`source is required for novel_source action=${args.action}`);
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

        if (args.action === "enable" || args.action === "disable") {
          const updated = await store.setSourceEnabled(session, projectId, record.id, args.action === "enable");
          return {
            action: args.action,
            summary: `${updated.name} [${updated.id}] is now ${updated.enabled ? "enabled" : "disabled"}.`,
            details: { project_id: projectId, source: updated },
          };
        }

        const stored = await store.readSource(session, projectId, record.id);
        if (stored === undefined) throw new Error(`source ${record.id} is listed but its file is missing`);
        const payload = stored.payload;
        const byChannel = lines(
          "通道明细：",
          ...INJECTABLE_CHANNELS.map((channel) => {
            const items = payload.entries.filter((entry) => entry.channel === channel);
            if (items.length === 0) return null;
            return lines(
              `- ${CHANNEL_LABEL[channel]}（${String(items.length)}，进世界书）`,
              ...items.slice(0, 12).map((entry) => `    · ${entry.name} — ${entry.reason}`),
              items.length > 12 ? `    … 另有 ${String(items.length - 12)} 条` : null,
            );
          }),
          ...payload.entries
            .filter((entry) => !INJECTABLE_CHANNELS.includes(entry.channel))
            .slice(0, 8)
            .map((entry) => `- ${CHANNEL_LABEL[entry.channel]}（不进世界书）：${entry.name} — ${entry.reason}`),
        );
        const meta = payload.meta;
        const summary = lines(
          `${payload.name} [${record.id}] · ${record.kind === "card" ? "卡" : "世界书"} · ${record.enabled ? "enabled" : "disabled"}`,
          `来源：${record.originFile}（${String(Math.round(record.originSize / 1024))} KB）`,
          meta === null
            ? null
            : lines(
                `卡面：description ${String(meta.description.length)} 字 · first_mes ${String(meta.firstMes.length)} 字` +
                  ` · 备选开场 ${String(meta.alternateGreetings.length)} 条 · tags ${meta.tags.join("/") || "(无)"}`,
                meta.scripts.length > 0
                  ? `运行时脚本 ${String(meta.scripts.length)} 段（不执行）：${meta.scripts.map((s) => s.name).join("、")}`
                  : null,
                meta.extensions.length > 0
                  ? `extensions：${meta.extensions.map((e) => `${e.path}(${e.detail})`).join(" · ")}`
                  : null,
              ),
          byChannel,
          payload.rules.trim() === "" ? null : `规则区文本 ${String(payload.rules.length)} 字（下一刀才会注入）`,
          payload.initvarText.trim() === "" ? null : `状态初值 ${String(payload.initvarText.length)} 字：${preview(payload.initvarText, 120)}`,
        );
        return {
          action: args.action,
          summary,
          details: {
            project_id: projectId,
            source: record,
            meta,
            counts: record.counts,
            entries: payload.entries.map((entry) => ({
              name: entry.name,
              channel: entry.channel,
              reason: entry.reason,
              enabled: entry.enabled,
              keys: entry.keys,
            })),
          },
        };
      },
    }),
  );
}
