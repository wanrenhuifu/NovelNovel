/**
 * novel_context：写作上下文组装（把「续写」要用的设定与前后文拼成一份简报）。
 *
 * harness 自己就是写作模型，所以这里不调用 LLM，而是把「作者设定 + 命中词条 +
 * 参与角色 + 预设模板 + 前文摘录 + 本章结尾」组装成一份写作简报交给 agent，
 * 拼装本身走 domain/prompt.ts 的 buildSystemPrompt / buildContinueUserMessage。
 */
import { buildContinueUserMessage, buildSystemPrompt, selectLoreEntries } from "../domain/prompt";
import { lines, TEXT_OUTPUT, textRender, type ToolDeps } from "./shared";

/**
 * 把简报参数夹到配置上限内。
 * 不夹的话 `prev_chapters: 999999` 会顺序读入此前每一章的全文、`prev_chars` 极大时
 * 整本书进提示词——都是模型一口气把上下文预算烧光的方式。
 */
function clamp(value: number, max: number): number {
  if (!Number.isFinite(value)) return max;
  return Math.min(Math.max(0, Math.trunc(value)), max);
}

export function registerContextTool({ ctx, store, config, defineTool }: ToolDeps): void {
  ctx.tools.register(
    defineTool({
      name: "novel_context",
      description: lines(
        "Assemble the writing brief for a chapter of the current novel project.",
        "Returns the authoritative setting/style guidance (built from worldbuilding, the lorebook entries whose keywords hit the context,",
        "the participating character cards and the active preset), the tail of the previous chapters, the tail of this chapter,",
        "and the exact instruction block to treat as the writing task.",
        "Call this before writing or continuing prose, then land the prose with novel_chapter action=append.",
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

        // 前文摘录也参与 lorebook 关键词匹配（与简报组装同一口径）
        const contextText = [...prev.map((item) => item.text), recent].join("\n");
        const systemPrompt = buildSystemPrompt(
          {
            title: project.title,
            synopsis: project.synopsis,
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
        );
        const userMessage = buildContinueUserMessage(recent, args.instruction ?? "", prev);
        const injected = selectLoreEntries(lorebook, contextText);
        const alwaysOn = injected.filter((entry) => !entry.keys.trim());
        const keywordHit = injected.filter((entry) => entry.keys.trim());
        // 可注入条目 = 启用且内容非空（与 selectLoreEntries 的过滤口径一致），
        // 否则「跳过 N 条」会把「启用但内容为空」的条目也算成「关键词没出现」。
        const eligible = lorebook.filter((entry) => entry.enabled && entry.content.trim());
        const skipped = eligible.length - injected.length;

        const summary = lines(
          `# Writing brief · 《${project.title}》 / ${chapter.title} [${chapter.id}]`,
          `chapter is ${chapter.words} words${chapter.tags.length > 0 ? ` · tags: ${chapter.tags.join("/")}` : ""}`,
          `preset: ${preset ? `${preset.name} (${preset.kind})` : "(built-in default)"}`,
          "",
          "## System prompt — the author's setting & style guidance (follow it)",
          systemPrompt.text,
          "",
          "## Instruction block — treat this as the writing task for this round",
          userMessage,
          "",
          "## Injected lorebook entries",
          keywordHit.length > 0
            ? `keyword-triggered: ${keywordHit.map((entry) => `${entry.name} [${entry.keys}]`).join(", ")}`
            : "keyword-triggered: (none)",
          alwaysOn.length > 0
            ? `always-on: ${alwaysOn.map((entry) => entry.name).join(", ")}`
            : "always-on: (none)",
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
            preset: preset?.name ?? null,
            system_prompt_chars: systemPrompt.text.length,
            preset_warnings: systemPrompt.warnings,
            prev_chapters: prev.map((item) => item.title),
            ...(prevResult.missing.length > 0 ? { prev_chapters_missing_body: prevResult.missing } : {}),
            recent_chars: recent.length,
            injected_entries: injected.map((entry) => entry.name),
            characters: characters.map((character) => character.name),
          },
        };
      },
    }),
  );
}
