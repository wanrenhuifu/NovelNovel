/**
 * novel_context：写作上下文组装（把「续写」要用的设定与前后文拼成一份简报）。
 *
 * harness 自己就是写作模型，所以这里不调用 LLM，而是把「作者设定 + 命中词条 +
 * 参与角色 + 预设模板 + 前文摘录 + 本章结尾」组装成一份写作简报交给 agent，
 * 拼装本身走 domain/prompt.ts 的 buildSystemPrompt / buildContinueUserMessage。
 *
 * 这一步是**每章都要跑的热路径**，所以默认全程本地（毫秒级、零模型往返），
 * 两个可选开关才可能起子 agent：`filter=true`（候选词条的语义筛选，只准删不准加）。
 */
import { buildContinueUserMessage, buildSystemPrompt, rankLoreEntries } from "../domain/prompt";
import { buildLoreFilterPrompt, normalizeLoreFilter, LORE_FILTER_OUTPUT_SCHEMA } from "../domain/loreFilter";
import { wordProgress } from "../domain/progress";
import { lines, TEXT_OUTPUT, textRender, type ToolDeps } from "./shared";
import { runStructuredSubagent } from "./subagent";

/** 候选池筛选的子 agent 角色说明（模型可见，所以是英文） */
const FILTER_PERSONA =
  "You triage a novel project's setting entries for one chapter. You only ever remove entries from the " +
  "candidate list you are given; you never add, rewrite or reorder anything. You report your answer with " +
  "the structured-report tool and stop.";

/**
 * 把简报参数夹到配置上限内。
 * 不夹的话 `prev_chapters: 999999` 会顺序读入此前每一章的全文、`prev_chars` 极大时
 * 整本书进提示词——都是模型一口气把上下文预算烧光的方式。
 */
function clamp(value: number, max: number): number {
  if (!Number.isFinite(value)) return max;
  return Math.min(Math.max(0, Math.trunc(value)), max);
}

export function registerContextTool({ ctx, store, config, defineTool, subagents }: ToolDeps): void {
  ctx.tools.register(
    defineTool({
      name: "novel_context",
      description: lines(
        "Assemble the writing brief for a chapter of the current novel project.",
        "Returns the authoritative setting/style guidance (built from worldbuilding, the lorebook entries whose keywords hit the context,",
        "the participating character cards and the active preset), the tail of the previous chapters, the tail of this chapter,",
        "the exact instruction block to treat as the writing task, and how much of the book is still unwritten.",
        "Call this before writing or continuing prose, then land the prose with novel_chapter action=append and check it with novel_review.",
      ),
      parameters: {
        chapter: {
          type: "string",
          required: true,
          description: "Chapter to write: id, 1-based number, or title (exact or unique partial).",
        },
        project: {
          type: "string",
          description: "Project id, title, or 1-based index. Defaults to the current project.",
        },
        instruction: {
          type: "string",
          description:
            "What this round should do, e.g. 承接上文，写完林晚与祭司的对峙. Empty means a plain continuation.",
        },
        prev_chapters: {
          type: "number",
          description: `How many preceding chapters to excerpt for continuity. Defaults to ${config.defaultPrevChapterCount}, maximum ${config.maxPrevChapterCount}.`,
        },
        prev_chars: {
          type: "number",
          description: `Characters taken from the tail of each preceding chapter. Defaults to ${config.defaultPrevChapterChars}, maximum ${config.maxPrevChapterChars}.`,
        },
        recent_chars: {
          type: "number",
          description: `Characters taken from the tail of this chapter as the continuation anchor. Defaults to ${config.defaultRecentChars}, maximum ${config.maxPrevChapterChars}.`,
        },
        filter: {
          type: "boolean",
          description:
            "Opt in to a semantic pass over the keyword-matched lorebook entries: a read-only sub-agent drops the ones that cannot affect this chapter. " +
            "Costs one sub-agent round trip; without it the brief is assembled locally only. Entries without keywords (always-on) are never dropped.",
        },
      },
      output: { schema: TEXT_OUTPUT, render: textRender },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const session = store.sessionOf(exec);
        const projectId = await store.resolveProjectId(session, args.project);
        const chapter = await store.readChapter(session, projectId, args.chapter);
        const project = await store.readProject(session, projectId);
        const lorebook = await store.readLorebook(session, projectId);
        const characters = await store.activeCharacters(session, projectId);
        const presetFile = await store.readPresets(session, projectId);
        const preset = store.activePreset(presetFile);

        const prevCount = clamp(args.prev_chapters ?? config.defaultPrevChapterCount, config.maxPrevChapterCount);
        const prevChars = clamp(args.prev_chars ?? config.defaultPrevChapterChars, config.maxPrevChapterChars);
        const recentChars = clamp(args.recent_chars ?? config.defaultRecentChars, config.maxPrevChapterChars);
        const prevResult = await store.previousExcerpts(
          session,
          projectId,
          chapter.id,
          prevCount,
          prevChars,
        );
        const prev = prevResult.excerpts;
        // 注意 slice(-0) === slice(0) 会取到整章，0 必须单独处理
        const recent = recentChars > 0 ? chapter.content.trim().slice(-recentChars) : "";

        // 参与 lorebook 关键词匹配的文本 = 前文摘录 + 本章已写正文 + **本章目标 / 这一轮的指令**。
        //
        // 为什么指令必须算进来：现代卡的触发词几乎全是人名/功法/地名，而它们**第一次出现往往就在
        // 指令里**（"写林若悠在玉灵宫修炼青云步"）。只看已写正文时，第一章永远匹配不到任何关键词
        // （正文还是空的），整本 290 条关键词世界书等于全程静默——实测《道渊》就是这样。
        const contextText = [
          ...prev.map((item) => item.text),
          recent,
          chapter.goal ?? "",
          args.instruction ?? "",
        ]
          .filter((part) => part.trim() !== "")
          .join("\n");

        // 第 6 步的本地治理：先拿到**完整候选池**（召回要全，不漏），
        // 再（可选）让子 agent 做一次只准删的筛选，最后才按条数/字符双上限取前若干条。
        const pool = rankLoreEntries(lorebook, contextText);
        let candidates = lorebook;
        let filterNote: string | null = null;
        if (args.filter === true) {
          // 只把**命中**的条目交出去筛：常驻条目是作者刻意每回合都带的，不在候选池里。
          if (pool.injected.length === 0) {
            filterNote = "semantic filter: skipped (no keyword-matched entries to triage)";
          } else {
            const outcome = await runStructuredSubagent({ config, subagents }, exec, {
              label: `novel_context filter: ${chapter.title}`,
              persona: FILTER_PERSONA,
              outputSchema: LORE_FILTER_OUTPUT_SCHEMA,
              prompt: buildLoreFilterPrompt({
                projectTitle: project.title,
                chapterTitle: chapter.title,
                goal: chapter.goal?.trim() ?? "",
                candidates: pool.injected,
                context: [recent, ...prev.map((item) => item.text)].join("\n"),
              }),
            });
            if (outcome.kind !== "ok") {
              filterNote = `semantic filter: ${outcome.kind === "unavailable" ? "UNAVAILABLE" : "FAILED"} (${outcome.reason}) — all candidates kept`;
            } else {
              const verdict = normalizeLoreFilter(outcome.structured, pool.injected);
              if (verdict === null) {
                filterNote = "semantic filter: unusable answer — all candidates kept";
              } else {
                candidates = lorebook.filter((entry) => !verdict.dropped.has(entry.id));
                const names = pool.injected
                  .filter((entry) => verdict.dropped.has(entry.id))
                  .map((entry) => entry.name || entry.keys);
                filterNote = lines(
                  `semantic filter: dropped ${verdict.dropped.size} of ${pool.injected.length} keyword-matched entries` +
                    (names.length > 0 ? ` (${names.join(", ")})` : ""),
                  verdict.unknown.length > 0
                    ? `⚠️ it also named ${verdict.unknown.length} id(s) that are not in the candidate list (ignored): ${verdict.unknown.join(", ")}`
                    : null,
                );
              }
            }
          }
        }

        const selection = rankLoreEntries(candidates, contextText, {
          maxEntries: config.maxInjectedLoreEntries,
          maxChars: config.maxInjectedLoreChars,
        });

        const systemPrompt = buildSystemPrompt(
          {
            title: project.title,
            synopsis: project.synopsis,
            // 大纲第一层（全书梗概）是 Push：老作品没有这个字段，按空串归一（输出与旧版逐字相同）
            outline: project.outline ?? "",
            worldbuilding: project.worldbuilding,
            authorNote: project.authorNote,
            lorebook,
          },
          characters.map((character) => ({
            name: character.name,
            description: character.description,
            personality: character.personality,
            scenario: character.scenario,
          })),
          contextText,
          preset,
          selection,
        );
        // 章级 goal 进**指令块**而不是系统提示词：buildSystemPrompt 收不到章节元数据
        // （见 domain/prompt.ts 的 buildContinueUserMessage）。为空时输出与旧版逐字相同。
        const userMessage = buildContinueUserMessage(
          recent,
          args.instruction ?? "",
          prev,
          chapter.goal ?? "",
        );
        const injected = [...selection.alwaysOn, ...selection.injected];
        const eligible = lorebook.filter((entry) => entry.enabled && entry.content.trim());
        const skipped = selection.skipped.length;
        const truncated = selection.truncated.map((entry) => entry.name || entry.keys);
        // 写作进度：**一次 listDir**，不读任何正文（自动写作循环每轮都要问"下一章是谁"）
        const progress = await store.chapterProgress(session, projectId);
        const next = progress.pending[0];
        // 只有设了全书目标字数才去量总字数（走按文件大小校验的缓存，但仍是额外调用）：
        // 老作品没有这个字段时，这一步的开销与加这个功能之前逐次相同
        const wordTarget =
          project.targetWords === undefined
            ? null
            : wordProgress(
                (await store.listChapterWordCounts(session, projectId)).words,
                project.targetWords,
              );

        const summary = lines(
          `# Writing brief · 《${project.title}》 / ${chapter.title} [${chapter.id}]`,
          `chapter is ${chapter.words} words${chapter.tags.length > 0 ? ` · tags: ${chapter.tags.join("/")}` : ""}`,
          `progress: ${progress.written}/${progress.total} chapters have text` +
            (next
              ? ` · next unwritten: ${next.title} [${next.id}]${next.goal?.trim() ? ` — goal: ${next.goal.trim()}` : ""}`
              : " · every chapter has text"),
          wordTarget === null ? null : `words: ${wordTarget}`,
          `preset: ${preset ? `${preset.name} (${preset.kind})` : "(built-in default)"}`,
          "",
          "## System prompt — the author's setting & style guidance (follow it)",
          systemPrompt.text,
          "",
          "## Instruction block — treat this as the writing task for this round",
          userMessage,
          "",
          "## Injected lorebook entries",
          selection.injected.length > 0
            ? `keyword-triggered (ranked by how many keywords hit, capped at ${config.maxInjectedLoreEntries} entries / ${config.maxInjectedLoreChars} chars): ${selection.injected.map((entry) => `${entry.name} [${entry.keys}]`).join(", ")}`
            : "keyword-triggered: (none)",
          selection.alwaysOn.length > 0
            ? `always-on (not capped): ${selection.alwaysOn.map((entry) => entry.name).join(", ")}`
            : "always-on: (none)",
          truncated.length > 0
            ? `(left out by the injection limits: ${truncated.join(", ")} — read lorebook.json if one of them matters here)`
            : null,
          filterNote,
          skipped > 0
            ? `(skipped ${skipped} injectable entries whose keywords did not appear)`
            : null,
          ...systemPrompt.warnings.map((warning) => `⚠️ ${warning}`),
          ...(prevResult.missing.length > 0
            ? [
                `⚠️ ${String(prevResult.missing.length)} preceding chapter(s) could not be excerpted ` +
                  `because their body file is missing on disk: ${prevResult.missing.join(", ")}. ` +
                  "This brief is therefore missing that context — restore the file(s) before continuing.",
              ]
            : []),
          "",
          "## Participating characters",
          characters.length > 0
            ? characters.map((character) => `- ${character.name} (${character.specVersion} card)`).join("\n")
            : "(none active — check novel_character action=enable if a card should participate)",
        );

        return {
          action: "context",
          summary,
          details: {
            project_id: projectId,
            chapter_id: chapter.id,
            chapter_title: chapter.title,
            chapter_words: chapter.words,
            // 没有 goal 的章节（含所有旧索引）如实报 null，不编一个空串出来
            goal: chapter.goal?.trim() ? chapter.goal.trim() : null,
            preset: preset?.name ?? null,
            system_prompt_chars: systemPrompt.text.length,
            preset_warnings: systemPrompt.warnings,
            prev_chapters: prev.map((item) => item.title),
            ...(prevResult.missing.length > 0 ? { prev_chapters_missing_body: prevResult.missing } : {}),
            recent_chars: recent.length,
            injected_entries: injected.map((entry) => entry.name),
            ...(truncated.length > 0 ? { truncated_entries: truncated } : {}),
            eligible_lore_entries: eligible.length,
            characters: characters.map((character) => character.name),
            target_words: project.targetWords ?? null,
            progress: {
              total: progress.total,
              written: progress.written,
              next_chapter_id: next?.id ?? null,
              next_chapter_title: next?.title ?? null,
              next_chapter_goal: next?.goal?.trim() ? next.goal.trim() : null,
            },
          },
        };
      },
    }),
  );
}
