/**
 * /novel 斜杠命令：不经过模型，直接把当前作品状态打印给用户。
 * 支持 `/novel`（状态）、`/novel list`（全部作品）、`/novel <作品>`（切换当前作品）。
 */
import type { CommandResult, Context } from "./contract";
import type { NovelStore } from "./store";
import { lines } from "./tools/shared";

export function registerNovelCommand(ctx: Context, store: NovelStore): void {
  ctx.commands.register({
    name: "novel",
    description: "Show (or switch) the current NovelNovel project in this workspace.",
    input: { hint: "[list | <project id or title>]" },
    async handler({ rawInput, signal, agent }): Promise<CommandResult> {
      const session = store.sessionFor(agent?.session, signal);
      try {
        const wanted = rawInput.trim();
        if (wanted === "list") {
          const { projects: summaries, unreadable } = await store.listProjects(session);
          if (summaries.length === 0) {
            return { kind: "success", text: "本工作区还没有作品，用 novel_project 工具新建一部。" };
          }
          return {
            kind: "success",
            text: lines(
              `共 ${summaries.length} 部作品：`,
              ...summaries.map(
                (item) =>
                  `- ${item.project.id} · 《${item.project.title}》${item.active ? "（当前）" : ""} — ${item.chapterCount} 章 / ${item.words} 字`,
              ),
              unreadable.length > 0
                ? `另有 ${unreadable.length} 个目录读不出来：${unreadable.map((item) => item.id).join(", ")}`
                : null,
            ),
          };
        }
        // 解析一次即可：给了显式引用就顺手切为当前作品，随后复用同一个 id 报告状态
        const projectId = await store.resolveProjectId(session, wanted || undefined);
        if (wanted) await store.setActiveProject(session, projectId);
        const project = await store.readProject(session, projectId);
        const chapters = await store.listChapters(session, projectId);
        const characters = await store.listCharacters(session, projectId);
        const lorebook = await store.readLorebook(session, projectId);
        const presets = await store.readPresets(session, projectId);
        const last = chapters[chapters.length - 1];
        const words = chapters.reduce((sum, chapter) => sum + chapter.words, 0);
        const activePreset = store.activePreset(presets);
        return {
          kind: "success",
          text: lines(
            `《${project.title}》(${projectId})${activePreset ? ` · 预设：${activePreset.name}` : " · 预设：内置默认"}`,
            `章节 ${chapters.length} · 全书 ${words} 字` + (last ? ` · 末章「${last.title}」${last.words} 字` : ""),
            `角色卡 ${characters.length}（参与 ${characters.filter((c) => c.active).length}）· 世界观词条 ${lorebook.length}`,
            `数据目录：${store.projectPath(projectId)}`,
          ),
        };
      } catch (error: unknown) {
        return { kind: "error", text: (error as Error).message };
      }
    },
  });
}
