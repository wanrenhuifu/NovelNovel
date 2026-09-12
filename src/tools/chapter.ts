/**
 * novel_chapter：章节的增删改查、排序、标签与全书检索。
 * 正文以 Markdown 文件存放，可用 read/write 工具直接编辑；这里的操作会同步章节元数据。
 */
import { lines, preview, TEXT_OUTPUT, textRender, type ToolDeps } from "./shared";

export function registerChapterTool({ ctx, store, defineTool }: ToolDeps): void {
  ctx.tools.register(
    defineTool({
      name: "novel_chapter",
      description: lines(
        "Read and write the chapters of a novel project.",
        "Use action=list for the outline, action=read to load a chapter before editing it,",
        "action=append to land newly written prose at the end of a chapter (the normal path for continuation),",
        "action=write to replace a chapter wholesale, action=create to add a chapter, action=rename/tag/move to keep the outline tidy,",
        "action=search to find a phrase across the whole book, action=delete (needs confirm=true) to drop one.",
        "Before writing prose, call novel_context to load the author's brief for that chapter.",
      ),
      parameters: {
        action: {
          type: "string",
          required: true,
          enum: ["list", "read", "create", "append", "write", "rename", "tag", "move", "search", "delete"],
          description: "What to do.",
        },
        project: {
          type: "string",
          description: "Project id, title, or 1-based index. Defaults to the current project.",
        },
        chapter: {
          type: "string",
          description:
            "Chapter reference: id, 1-based number, or title (exact or unique partial). Required unless action=create/list/search.",
        },
        title: { type: "string", description: "Chapter title (action=create/rename)." },
        text: {
          type: "string",
          description: "Prose content: appended with action=append, replacing the chapter with action=write.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Replace the chapter's tags with this list (action=tag).",
        },
        add_tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags to add (action=tag), e.g. 伏笔 / 高潮 / 待修.",
        },
        remove_tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags to remove (action=tag).",
        },
        position: {
          type: "number",
          description: "1-based insertion point for action=create; defaults to the end of the book.",
        },
        target: {
          type: "string",
          description: "Chapter reference to move next to (action=move).",
        },
        relative: {
          type: "string",
          enum: ["before", "after"],
          description: "Place the moved chapter before or after `target` (action=move). Defaults to before.",
        },
        query: { type: "string", description: "Phrase to search for, case-insensitive (action=search)." },
        limit: { type: "number", description: "Maximum search hits to return. Defaults to 50." },
        confirm: {
          type: "boolean",
          description: "Must be true to delete a chapter. Ask the user first.",
        },
      },
      output: { schema: TEXT_OUTPUT, render: textRender },
      isConcurrencySafe: (args) =>
        args.action === "list" || args.action === "read" || args.action === "search",
      async execute(args, exec) {
        const session = store.sessionOf(exec);
        const projectId = await store.resolveProjectId(session, args.project);

        if (args.action === "list") {
          const chapters = await store.listChapters(session, projectId);
          const words = chapters.reduce((sum, chapter) => sum + chapter.words, 0);
          const summary = lines(
            chapters.length === 0
              ? `No chapter yet. Add one with novel_chapter action=create title="<chapter title>".`
              : `Chapters (${chapters.length}, ${words} words total):`,
            ...chapters.map((chapter, index) =>
              lines(
                `${index + 1}. ${chapter.title} [${chapter.id}] — ${chapter.words} words` +
                  (chapter.tags.length > 0 ? ` · tags: ${chapter.tags.join("/")}` : ""),
                chapter.content.trim() ? `   ${preview(chapter.content, 70)}` : "   (empty)",
              ),
            ),
          );
          return {
            action: args.action,
            summary,
            details: {
              project_id: projectId,
              chapters: chapters.map((chapter, index) => ({
                index: index + 1,
                id: chapter.id,
                title: chapter.title,
                tags: chapter.tags,
                words: chapter.words,
              })),
              words,
            },
          };
        }

        if (args.action === "create") {
          if (!args.title?.trim()) {
            throw new Error("title is required for novel_chapter action=create");
          }
          const chapter = await store.createChapter(session, projectId, {
            title: args.title,
            ...(args.text !== undefined ? { content: args.text } : {}),
            ...(args.tags !== undefined ? { tags: args.tags } : {}),
            ...(args.position !== undefined ? { position: args.position } : {}),
          });
          return {
            action: args.action,
            summary: `Created chapter 「${chapter.title}」 [${chapter.id}] (${chapter.words} words).`,
            details: { project_id: projectId, chapter_id: chapter.id, words: chapter.words },
          };
        }

        if (args.action === "search") {
          if (!args.query?.trim()) throw new Error("query is required for novel_chapter action=search");
          const hits = await store.search(session, projectId, args.query, args.limit ?? 50);
          const summary = lines(
            hits.length === 0
              ? `No hit for "${args.query}".`
              : `${hits.length} hit(s) for "${args.query}":`,
            ...hits.map(
              (hit) =>
                `- ${hit.chapterTitle}${hit.pos === null ? " (title match)" : ` @${hit.pos}`}: ` +
                hit.segments.map((segment) => segment.text).join(""),
            ),
          );
          return {
            action: args.action,
            summary,
            details: {
              query: args.query,
              hits: hits.map((hit) => ({
                chapter_id: hit.chapterId,
                chapter_title: hit.chapterTitle,
                pos: hit.pos,
              })),
            },
          };
        }

        if (!args.chapter?.trim()) {
          throw new Error(`chapter is required for novel_chapter action=${args.action}`);
        }
        const meta = await store.resolveChapterId(session, projectId, args.chapter);

        if (args.action === "read") {
          const chapter = await store.readChapter(session, projectId, meta.id);
          const summary = lines(
            `# ${chapter.title} [${chapter.id}] — ${chapter.words} words` +
              (chapter.tags.length > 0 ? ` · tags: ${chapter.tags.join("/")}` : ""),
            chapter.content.trim() ? "" : "(empty chapter)",
            chapter.content.trim() ? chapter.content : null,
          );
          return {
            action: args.action,
            summary,
            details: {
              project_id: projectId,
              chapter_id: chapter.id,
              title: chapter.title,
              words: chapter.words,
              content: chapter.content,
            },
          };
        }

        if (args.action === "append") {
          if (!args.text?.trim()) throw new Error("text is required for novel_chapter action=append");
          const chapter = await store.appendChapterBody(session, projectId, meta.id, args.text);
          return {
            action: args.action,
            summary: lines(
              `Appended ${args.text.trim().length} characters to 「${chapter.title}」 [${chapter.id}].`,
              `Chapter is now ${chapter.words} words.`,
            ),
            details: {
              project_id: projectId,
              chapter_id: chapter.id,
              words: chapter.words,
              appended_chars: args.text.trim().length,
            },
          };
        }

        if (args.action === "write") {
          if (args.text === undefined) throw new Error("text is required for novel_chapter action=write");
          const chapter = await store.writeChapterBody(session, projectId, meta.id, args.text);
          return {
            action: args.action,
            summary: `Replaced 「${chapter.title}」 [${chapter.id}] — now ${chapter.words} words.`,
            details: { project_id: projectId, chapter_id: chapter.id, words: chapter.words },
          };
        }

        if (args.action === "rename") {
          if (!args.title?.trim()) throw new Error("title is required for novel_chapter action=rename");
          const renamed = await store.updateChapterMeta(session, projectId, meta.id, {
            title: args.title,
          });
          return {
            action: args.action,
            summary: `Renamed 「${meta.title}」 to 「${renamed.title}」 [${renamed.id}].`,
            details: { project_id: projectId, chapter_id: renamed.id, title: renamed.title },
          };
        }

        if (args.action === "tag") {
          if (
            args.tags === undefined &&
            args.add_tags === undefined &&
            args.remove_tags === undefined
          ) {
            throw new Error(
              "nothing to do: pass tags / add_tags / remove_tags for novel_chapter action=tag",
            );
          }
          const tagged = await store.updateChapterMeta(session, projectId, meta.id, {
            ...(args.tags !== undefined ? { tags: args.tags } : {}),
            ...(args.add_tags !== undefined ? { addTags: args.add_tags } : {}),
            ...(args.remove_tags !== undefined ? { removeTags: args.remove_tags } : {}),
          });
          return {
            action: args.action,
            summary: `「${tagged.title}」 tags: ${tagged.tags.length > 0 ? tagged.tags.join("/") : "(none)"}.`,
            details: { project_id: projectId, chapter_id: tagged.id, tags: tagged.tags },
          };
        }

        if (args.action === "move") {
          if (!args.target?.trim()) throw new Error("target is required for novel_chapter action=move");
          const target = await store.resolveChapterId(session, projectId, args.target);
          const relative = args.relative === "after" ? "after" : "before";
          const ordered = await store.moveChapter(session, projectId, meta.id, target.id, relative);
          const noop = meta.id === target.id;
          return {
            action: args.action,
            summary: lines(
              noop
                ? `No move: 「${meta.title}」 is the target itself.`
                : `Moved 「${meta.title}」 ${relative} 「${target.title}」.`,
              `New order: ${ordered.map((item) => item.title).join(" → ")}`,
            ),
            details: { project_id: projectId, order: ordered.map((item) => item.id), moved: !noop },
          };
        }

        if (args.action === "delete") {
          const deleted = await store.deleteChapter(session, projectId, meta.id, args.confirm);
          return {
            action: args.action,
            summary: `Deleted chapter 「${deleted.title}」 [${deleted.id}].`,
            details: { project_id: projectId, chapter_id: deleted.id },
          };
        }

        throw new Error(`unhandled action: ${args.action}`);
      },
    }),
  );
}
