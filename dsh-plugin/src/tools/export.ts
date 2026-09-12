/**
 * novel_export：整书导出与全量备份（写文件，不做下载）。
 */
import { lines, TEXT_OUTPUT, textRender, type ToolDeps } from "./shared";

export function registerExportTool({ ctx, store, defineTool }: ToolDeps): void {
  ctx.tools.register(
    defineTool({
      name: "novel_export",
      description: lines(
        "Export a novel project to a file in the workspace.",
        "action=markdown / action=text write the whole book (chapters in order) as .md or .txt;",
        "action=backup writes one JSON with the project, chapters, cards, presets and lorebook as an archive.",
        "Note: card avatar images live as separate PNG files and are not embedded in the backup JSON, and the plugin has no restore command yet.",
        "Files land in the project's exports/ directory unless the project data dir was configured elsewhere.",
      ),
      parameters: {
        action: {
          type: "string",
          required: true,
          enum: ["markdown", "text", "backup"],
          description: "Export format.",
        },
        project: {
          type: "string",
          description: "Project id, title, or 1-based index. Defaults to the current project.",
        },
      },
      output: { schema: TEXT_OUTPUT, render: textRender },
      // 会写文件：不声明 isConcurrencySafe，让它单独执行（快照不会被并行写打断）
      async execute(args, exec) {
        const session = store.sessionOf(exec);
        const projectId = await store.resolveProjectId(session, args.project);
        const result =
          args.action === "backup"
            ? await store.exportBackup(session, projectId)
            : await store.exportDocument(
                session,
                projectId,
                args.action === "markdown" ? "md" : "txt",
              );
        return {
          action: args.action,
          summary: lines(
            `Exported ${result.chapters} chapter(s), ${result.words} words (${result.bytes} bytes):`,
            `  ${result.path}`,
            args.action === "backup"
              ? "Backup holds text/settings only — card avatars stay as files next to their cards, and there is no restore command."
              : null,
          ),
          details: {
            project_id: projectId,
            path: result.path,
            chapters: result.chapters,
            words: result.words,
            bytes: result.bytes,
          },
        };
      },
    }),
  );
}
