/**
 * novel_project：作品（一部小说）的创建、查看、切换与删除。
 * 作品是章节、角色卡、世界书与预设的容器，数据落在 <工作目录>/<dataDir>/projects/<id>/。
 */
import type { NovelProject } from "../types";
import type { ProjectPatch } from "../store";
import { lines, requireFields, TEXT_OUTPUT, textRender, type ToolDeps } from "./shared";

function describe(project: NovelProject, chapterCount: number, words: number, active: boolean): string {
  return lines(
    `- ${project.id} · 《${project.title}》${active ? " [current]" : ""}`,
    `  chapters: ${chapterCount}, words: ${words}`,
    project.synopsis.trim() ? `  synopsis: ${project.synopsis.trim()}` : null,
  );
}

export function registerProjectTool({ ctx, store, defineTool }: ToolDeps): void {
  ctx.tools.register(
    defineTool({
      name: "novel_project",
      description: lines(
        "Manage novel writing projects (one project = one novel: chapters, character cards, lorebook, writing presets).",
        "Use action=create to start a new novel, action=show to load a project's settings before writing,",
        "action=update to set the worldbuilding / writing requirements that steer the prose,",
        "action=list to see all projects, action=use to switch the current one, action=delete (needs confirm=true) to remove one.",
        "Chapter text lives in novel_chapter; card import in novel_character; setting entries in novel_lorebook.",
      ),
      parameters: {
        action: {
          type: "string",
          required: true,
          enum: ["list", "create", "show", "update", "use", "delete"],
          description: "What to do with the project.",
        },
        project: {
          type: "string",
          description:
            "Project id, title, or 1-based index from action=list. Defaults to the current project.",
        },
        title: { type: "string", description: "Novel title; required for action=create." },
        synopsis: { type: "string", description: "One-paragraph blurb shown to readers." },
        worldbuilding: {
          type: "string",
          description: "World / background setting injected into the writing brief.",
        },
        author_note: {
          type: "string",
          description: "Writing requirements and style notes injected into the writing brief.",
        },
        confirm: {
          type: "boolean",
          description: "Must be true to delete a project. Ask the user first.",
        },
      },
      output: { schema: TEXT_OUTPUT, render: textRender },
      isConcurrencySafe: (args) => args.action === "list" || args.action === "show",
      async execute(args, exec) {
        const session = store.sessionOf(exec);

        if (args.action === "list") {
          const { projects: summaries, unreadable } = await store.listProjects(session);
          const summary = lines(
            summaries.length === 0
              ? unreadable.length > 0
                ? "No readable project in this workspace."
                : `No project yet in this workspace. Create one with novel_project action=create title="<novel title>".`
              : `Projects (${summaries.length}), [current] marks the default target:`,
            ...summaries.map((s) => describe(s.project, s.chapterCount, s.words, s.active)),
            unreadable.length > 0
              ? lines(
                  "",
                  `Unreadable project directories (skipped, fix or remove them):`,
                  ...unreadable.map((item) => `- ${item.id}: ${item.error}`),
                )
              : null,
          );
          return {
            action: args.action,
            summary,
            details: {
              projects: summaries.map((s) => ({
                id: s.project.id,
                title: s.project.title,
                chapters: s.chapterCount,
                words: s.words,
                active: s.active,
              })),
              unreadable: unreadable.map((item) => ({ id: item.id, error: item.error })),
            },
          };
        }

        if (args.action === "create") {
          if (!args.title?.trim()) throw new Error("title is required for novel_project action=create");
          const project = await store.createProject(session, {
            title: args.title,
            ...(args.synopsis !== undefined ? { synopsis: args.synopsis } : {}),
            ...(args.worldbuilding !== undefined ? { worldbuilding: args.worldbuilding } : {}),
            ...(args.author_note !== undefined ? { authorNote: args.author_note } : {}),
          });
          return {
            action: args.action,
            summary: lines(
              `Created project ${project.id} · 《${project.title}》 and made it current.`,
              "Next: novel_chapter action=create to add the first chapter, or novel_character action=import to bring in a SillyTavern card.",
            ),
            details: { project_id: project.id, title: project.title },
          };
        }

        const projectId = await store.resolveProjectId(session, args.project);

        if (args.action === "use") {
          await store.setActiveProject(session, projectId);
          const project = await store.readProject(session, projectId);
          return {
            action: args.action,
            summary: `Current project is now ${projectId} · 《${project.title}》.`,
            details: { project_id: projectId },
          };
        }

        if (args.action === "update") {
          const patch: ProjectPatch = {};
          if (args.title !== undefined) patch.title = args.title;
          if (args.synopsis !== undefined) patch.synopsis = args.synopsis;
          if (args.worldbuilding !== undefined) patch.worldbuilding = args.worldbuilding;
          if (args.author_note !== undefined) patch.authorNote = args.author_note;
          const fields = Object.keys(patch);
          requireFields(
            fields,
            "nothing to update: pass at least one of title / synopsis / worldbuilding / author_note",
          );
          const project = await store.updateProject(session, projectId, patch);
          return {
            action: args.action,
            summary: lines(
              `Updated project ${project.id} · 《${project.title}》.`,
              `  fields: ${fields.join(", ")}`,
            ),
            details: { project_id: project.id, updated: fields },
          };
        }

        if (args.action === "delete") {
          const project = await store.readProject(session, projectId);
          // 只数索引条目即可得到章数（不必读遍正文）
          const chapterCount = (await store.listChapterMetas(session, projectId)).length;
          await store.deleteProject(session, projectId, args.confirm);
          return {
            action: args.action,
            summary: `Deleted project ${projectId} · 《${project.title}》 (${chapterCount} chapters).`,
            details: { project_id: projectId, chapters: chapterCount },
          };
        }

        if (args.action === "show") {
          const project = await store.readProject(session, projectId);
          const chapters = await store.listChapters(session, projectId);
          const characters = await store.listCharacters(session, projectId);
          const lorebook = await store.readLorebook(session, projectId);
          const presets = await store.readPresets(session, projectId);
          const activePreset = store.activePreset(presets);
          const words = chapters.reduce((sum, chapter) => sum + chapter.words, 0);
          return {
            action: args.action,
            summary: lines(
              `《${project.title}》 (${project.id})`,
              `chapters: ${chapters.length}, words: ${words}`,
              `characters: ${characters.length} (${characters.filter((c) => c.active).length} active)`,
              `lorebook: ${lorebook.length} entries (${lorebook.filter((e) => e.enabled).length} enabled)`,
              `preset: ${activePreset ? activePreset.name : "(built-in default)"}`,
              project.synopsis.trim() ? `\nsynopsis: ${project.synopsis.trim()}` : null,
              project.worldbuilding.trim() ? `\nworldbuilding: ${project.worldbuilding.trim()}` : null,
              project.authorNote.trim() ? `\nwriting requirements: ${project.authorNote.trim()}` : null,
            ),
            details: {
              project_id: project.id,
              title: project.title,
              chapters: chapters.length,
              words,
              characters: characters.length,
              lorebook_entries: lorebook.length,
              active_preset: activePreset?.name ?? null,
            },
          };
        }

        throw new Error(`unhandled action: ${args.action}`);
      },
    }),
  );
}
