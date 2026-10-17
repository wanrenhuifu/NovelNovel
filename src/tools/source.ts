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
import { rankLoreEntries, splitLoreKeys } from "../domain/prompt";
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
          enum: ["list", "show", "entries", "import", "enable", "disable"],
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
          description:
            "Source id (exact or unique partial). Required for show/enable/disable; optional for entries (default: the whole project world book).",
        },
        channel: {
          type: "string",
          enum: ["lore", "style", "gameplay", "state", "cast", "material"],
          description: "action=entries: only entries classified into this channel.",
        },
        always_on: {
          type: "boolean",
          description: "action=entries: true = only entries injected every turn (constant or no keys); false = only keyword-triggered ones.",
        },
        query: {
          type: "string",
          description: "action=entries: case-insensitive substring over name, keys and content.",
        },
        from: {
          type: "number",
          description: "action=entries: 1-based offset into the filtered list. Defaults to 1.",
        },
        limit: {
          type: "number",
          description: "action=entries: page size (default 20, max 200).",
        },
        chapter: {
          type: "string",
          description:
            "action=entries: chapter id, title, or 1-based index. When given, each entry also reports whether this chapter would inject it and why.",
        },
        instruction: {
          type: "string",
          description: "action=entries: the instruction/goal you are about to write with (used together with chapter to judge keyword hits).",
        },
      },
      output: { schema: TEXT_OUTPUT, render: textRender },
      isConcurrencySafe: (args) => args.action === "list" || args.action === "show" || args.action === "entries",
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

        // 世界书浏览：342 条的设定集没有目录、没有检索就等于用不了。
        // 这一支**只读**：按通道/常驻/关键词过滤 + 分页，带 chapter 时还会告诉你每条**为什么**会/不会
        // 进这一章的简报（与被注入侧同一套判定：直接调 rankLoreEntries，不重复实现一遍匹配）。
        if (args.action === "entries") {
          const lorebook = await store.readLorebook(session, projectId);
          let pool = lorebook;
          let scope = "整本世界书";
          const wantedSource = args.source?.trim() ?? "";
          if (wantedSource !== "") {
            const sources = await store.listSources(session, projectId);
            const exact = sources.find((item) => item.id === wantedSource);
            const partial = sources.filter(
              (item) => item.name.includes(wantedSource) || item.id.startsWith(wantedSource),
            );
            const record = exact ?? (partial.length === 1 ? partial[0] : undefined);
            if (record === undefined) {
              throw new Error(
                partial.length === 0
                  ? `no source matches "${wantedSource}"`
                  : `"${wantedSource}" is ambiguous: ${partial.map((item) => `${item.name} [${item.id}]`).join(", ")}`,
              );
            }
            pool = lorebook.filter((entry) => entry.source === record.id);
            scope = record.name;
          }

          const isAlwaysOn = (entry: (typeof lorebook)[number]): boolean =>
            entry.constant === true || splitLoreKeys(entry.keys).length === 0;
          const channelOf = (entry: (typeof lorebook)[number]): Channel => entry.channel ?? "lore";

          // 先算整本（过滤前）的通道分布，给调用方一个方位感
          const counts: Record<string, number> = {};
          for (const entry of pool) counts[channelOf(entry)] = (counts[channelOf(entry)] ?? 0) + 1;

          let filtered = pool;
          if (args.channel !== undefined) {
            filtered = filtered.filter((entry) => channelOf(entry) === args.channel);
          }
          if (args.always_on !== undefined) {
            filtered = filtered.filter((entry) => isAlwaysOn(entry) === args.always_on);
          }
          const query = args.query?.trim().toLowerCase() ?? "";
          if (query !== "") {
            filtered = filtered.filter((entry) =>
              `${entry.name}\n${entry.keys}\n${entry.content}`.toLowerCase().includes(query),
            );
          }

          // 「为什么进简报」：给章就按注入侧的判定跑一遍（常驻 / 命中哪些关键词 / 没命中 / 已禁用）
          let chapterLabel = "";
          const why = new Map<string, string>();
          if (args.chapter !== undefined && args.chapter.trim() !== "") {
            const chapter = await store.readChapter(session, projectId, args.chapter.trim());
            const tail = chapter.content.trim().slice(-2000);
            const contextText = [tail, chapter.goal ?? "", args.instruction ?? ""]
              .filter((part) => part.trim() !== "")
              .join("\n");
            const selection = rankLoreEntries(lorebook, contextText);
            chapterLabel = chapter.title;
            for (const entry of selection.alwaysOn) why.set(entry.id, "每回合都进（常驻）");
            for (const entry of selection.injected) {
              why.set(entry.id, `命中关键词（${entry.keys}）`);
            }
            for (const entry of selection.skipped) why.set(entry.id, "关键词没出现在本章上下文里");
          }

          const total = filtered.length;
          const from = Math.max(1, Math.trunc(args.from ?? 1));
          const limit = Math.min(200, Math.max(1, Math.trunc(args.limit ?? 20)));
          const page = filtered.slice(from - 1, from - 1 + limit);
          const summary = lines(
            `${scope} · ${String(pool.length)} 条（${Object.entries(counts)
              .map(([channel, count]) => `${CHANNEL_LABEL[channel as Channel] ?? channel} ${String(count)}`)
              .join(" · ")}）`,
            chapterLabel === "" ? null : `按「${chapterLabel}」判断：每条会/不会进简报及原因`,
            total === 0
              ? "没有符合条件的条目。"
              : `第 ${String(from)}–${String(from + page.length - 1)} 条（共 ${String(total)} 条）：`,
            ...page.map((entry) =>
              lines(
                `- ${entry.name}${entry.enabled ? "" : " (disabled)"}${entry.constant === true ? " [constant]" : ""}` +
                  `${splitLoreKeys(entry.keys).length === 0 ? " [无关键词]" : ""}`,
                `  ${CHANNEL_LABEL[channelOf(entry)]}${entry.keys.trim() === "" ? "" : ` · 关键词 ${entry.keys}`}`,
                why.size > 0 ? `  → ${why.get(entry.id) ?? "不在本章的候选里（已禁用或内容为空）"}` : null,
                `  ${preview(entry.content, 120)}`,
              ),
            ),
            total > from - 1 + page.length ? `（还有 ${String(total - (from - 1 + page.length))} 条，用 from=${String(from + page.length)} 翻页）` : null,
          );
          return {
            action: args.action,
            summary,
            details: {
              project_id: projectId,
              source: wantedSource === "" ? null : wantedSource,
              total: pool.length,
              matched: total,
              counts,
              from,
              limit,
              chapter: chapterLabel === "" ? null : chapterLabel,
              entries: page.map((entry) => ({
                id: entry.id,
                name: entry.name,
                channel: channelOf(entry),
                constant: entry.constant === true,
                keys: entry.keys,
                enabled: entry.enabled,
                always_on: isAlwaysOn(entry),
                why: why.get(entry.id) ?? null,
              })),
            },
          };
        }

        const wanted = args.source?.trim() ?? "";        if (wanted === "") throw new Error(`source is required for novel_source action=${args.action}`);
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
