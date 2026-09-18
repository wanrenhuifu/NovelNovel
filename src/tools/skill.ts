/**
 * novel_skill：项目级写作方法技能（harness 自己的 `.dsh/skills/`，不是插件内置的那几个）。
 *
 * 内置技能随包走、rank 250；这里管的技能落在项目根，rank 100，所以同名时会覆盖内置版。
 * 工具只做导入/导出/删除，实际加载交给 harness 的本地 provider——不维护第二套技能机制。
 */
import { lines, preview, TEXT_OUTPUT, textRender, type ToolDeps } from "./shared";

export function registerSkillTool({ ctx, skillStore, config, defineTool }: ToolDeps): void {
  ctx.tools.register(
    defineTool({
      name: "novel_skill",
      description: lines(
        "Manage project-level writing-method skills: SKILL.md files under .dsh/skills/ in the project root,",
        "which the harness discovers and loads by itself (a project skill outranks a bundled one of the same name).",
        "action=list shows what is installed; action=import reads a JSON skill pack from disk;",
        "action=export writes one skill back out as a pack so it can be shared; action=remove deletes an imported skill.",
        "Use the bundled craft skills (novel-prose, novel-dialogue, novel-scene, novel-outline) by default;",
        "reach for this tool when the user brings their own method, wants a skill edited as a file, or asks to share one.",
      ),
      parameters: {
        action: {
          type: "string",
          required: true,
          enum: ["list", "import", "export", "remove"],
          description: "What to do.",
        },
        path: {
          type: "string",
          description: "Path to the skill pack .json to import (action=import), absolute or workspace-relative.",
        },
        name: {
          type: "string",
          description: "Skill name to export or remove (exact, or unique partial match). Required except for list/import.",
        },
        out_path: {
          type: "string",
          description: `Where to write the exported pack (action=export). Defaults to ${config.dataDir}/skillpacks/.`,
        },
        overwrite: {
          type: "boolean",
          description: "Let action=import replace hand-written skills. Ask the user first.",
        },
        confirm: {
          type: "boolean",
          description: "Must be true to remove a skill. Ask the user first.",
        },
      },
      output: { schema: TEXT_OUTPUT, render: textRender },
      isConcurrencySafe: (args) => args.action === "list",
      async execute(args, exec) {
        const session = skillStore.sessionOf(exec);

        if (args.action === "list") {
          const skills = await skillStore.list(session);
          return {
            action: args.action,
            summary: lines(
              skills.length === 0
                ? "No project-level skills yet. The bundled craft skills (novel-prose, novel-dialogue, novel-scene, novel-outline) are always available; import a pack with novel_skill action=import to add the user's own method."
                : `Project skills (${skills.length}), loaded by the harness from the project root's .dsh/skills:`,
              ...skills.map((skill) =>
                lines(
                  `- ${skill.name}${skill.imported ? ` · imported from 「${skill.imported.pack}」` : " · hand-written"}` +
                    (skill.shadowsBundled ? " · overrides the bundled skill of the same name" : ""),
                  `  ${preview(skill.description, 90)}`,
                ),
              ),
            ),
            details: {
              skills: skills.map((skill) => ({
                name: skill.name,
                path: skill.path,
                imported: Boolean(skill.imported),
                shadows_bundled: skill.shadowsBundled,
              })),
            },
          };
        }

        if (args.action === "import") {
          if (!args.path?.trim()) {
            throw new Error("path is required for novel_skill action=import");
          }
          const result = await skillStore.importPack(session, args.path.trim(), args.overwrite);
          return {
            action: args.action,
            summary: lines(
              `Imported skill pack 「${result.pack}」 (${result.written.length} skill(s)):`,
              ...result.written.map(
                (item) => `- ${item.name}${item.overwritten ? " (overwrote the previous one)" : ""} → ${item.path}`,
              ),
              "The harness watches this directory, so the skills are already live in this session.",
            ),
            details: {
              pack: result.pack,
              skills: result.written.map((item) => ({
                name: item.name,
                path: item.path,
                overwritten: item.overwritten,
              })),
            },
          };
        }

        if (!args.name?.trim()) {
          throw new Error(`name is required for novel_skill action=${args.action}`);
        }

        if (args.action === "export") {
          const result = await skillStore.exportPack(session, args.name.trim(), args.out_path);
          return {
            action: args.action,
            summary: lines(
              `Exported skill 「${result.pack.skills[0]?.name ?? args.name.trim()}」 as a skill pack:`,
              `  ${result.path}`,
              "The pack is the same JSON shape novel_skill action=import accepts, so it can be shared as-is.",
            ),
            details: { path: result.path, pack: result.pack.name },
          };
        }

        const removed = await skillStore.remove(session, args.name.trim(), args.confirm);
        return {
          action: args.action,
          summary: lines(
            `Removed skill 「${removed.name}」 (${removed.path}).`,
            "The harness drops it from the catalog on its own; the bundled skills are untouched.",
          ),
          details: { name: removed.name, path: removed.path },
        };
      },
    }),
  );
}
