/**
 * novel_character：SillyTavern 角色卡的导入 / 查看 / 参与开关 / 再导出。
 * 导入时卡内世界书（character_book）会按来源卡名解析 {{char}} 后并入项目 lorebook。
 */
import type { CharacterPatch } from "../store";
import { lines, preview, requireFields, TEXT_OUTPUT, textRender, type ToolDeps } from "./shared";

export function registerCharacterTool({ ctx, store, defineTool }: ToolDeps): void {
  ctx.tools.register(
    defineTool({
      name: "novel_character",
      description: lines(
        "Manage SillyTavern character cards (PNG or JSON, V1/V2/V3) for a novel project.",
        "action=import reads a card file from disk, stores it, and merges the card's embedded world book into the project lorebook.",
        "Only cards with active=true contribute their description/personality/scenario to the writing brief; toggle with action=enable/disable.",
        "action=export writes the card back out as a SillyTavern-compatible PNG.",
      ),
      parameters: {
        action: {
          type: "string",
          required: true,
          enum: ["list", "show", "import", "update", "enable", "disable", "export", "remove"],
          description: "What to do.",
        },
        project: {
          type: "string",
          description: "Project id, title, or 1-based index. Defaults to the current project.",
        },
        character: {
          type: "string",
          description: "Card id or name (exact or unique partial). Required except for list/import.",
        },
        path: {
          type: "string",
          description: "Path to the .png/.json card file to import (absolute or relative to the workspace).",
        },
        name: { type: "string", description: "Rename the card (action=update)." },
        description: { type: "string", description: "Replace the card description (action=update)." },
        personality: { type: "string", description: "Replace the personality field (action=update)." },
        scenario: { type: "string", description: "Replace the scenario field (action=update)." },
        out_path: {
          type: "string",
          description: "Where to write the exported PNG (action=export). Defaults to the project's exports/ dir.",
        },
        confirm: {
          type: "boolean",
          description: "Must be true to remove a card. Ask the user first.",
        },
      },
      output: { schema: TEXT_OUTPUT, render: textRender },
      isConcurrencySafe: (args) => args.action === "list" || args.action === "show",
      async execute(args, exec) {
        const session = store.sessionOf(exec);
        const projectId = await store.resolveProjectId(session, args.project);

        if (args.action === "list") {
          const characters = await store.listCharacters(session, projectId);
          const summary = lines(
            characters.length === 0
              ? "No character card yet. Import one with novel_character action=import path=<card.png>."
              : `Character cards (${characters.length}):`,
            ...characters.map((character) =>
              lines(
                `- ${character.name} [${character.id}] · ${character.specVersion} card` +
                  ` · ${character.active ? "participating" : "not participating"}`,
                `  ${preview(character.description, 80) || "(no description)"}`,
              ),
            ),
          );
          return {
            action: args.action,
            summary,
            details: {
              project_id: projectId,
              characters: characters.map((character) => ({
                id: character.id,
                name: character.name,
                spec: character.specVersion,
                active: character.active,
              })),
            },
          };
        }

        if (args.action === "import") {
          if (!args.path?.trim()) {
            throw new Error("path is required for novel_character action=import");
          }
          const result = await store.importCharacter(session, projectId, args.path.trim());
          const character = result.character;
          return {
            action: args.action,
            summary: lines(
              `Imported 「${character.name}」 [${character.id}] as a ${character.specVersion} card.`,
              `  avatar: ${character.avatar ? "stored" : "none"}`,
              `  card world book entries merged into project lorebook: ${result.mergedLoreEntries}` +
                (result.skippedLoreEntries > 0
                  ? ` (${result.skippedLoreEntries} duplicates skipped)`
                  : ""),
              character.description.trim() ? `  description: ${preview(character.description, 140)}` : null,
              character.active
                ? "The card is active, so its setting already flows into novel_context."
                : "The card is inactive: enable it with action=enable when it should join the brief.",
            ),
            details: {
              project_id: projectId,
              character_id: character.id,
              name: character.name,
              spec: character.specVersion,
              lore_entries_merged: result.mergedLoreEntries,
            },
          };
        }

        if (!args.character?.trim()) {
          throw new Error(`character is required for novel_character action=${args.action}`);
        }
        const card = await store.resolveCharacter(session, projectId, args.character);

        if (args.action === "show") {
          return {
            action: args.action,
            summary: lines(
              `「${card.name}」 [${card.id}] · ${card.specVersion} card · ${card.active ? "participating" : "not participating"}`,
              `creator: ${card.creator || "(unknown)"} · card world book entries: ${card.lorebookCount}`,
              "Fields are shown as stored: {{char}} / <BOT> resolve to this card's name and {{user}} / <USER> to the protagonist (default 主角) when novel_context assembles the brief.",
              card.description.trim() ? `\ndescription:\n${card.description.trim()}` : null,
              card.personality.trim() ? `\npersonality:\n${card.personality.trim()}` : null,
              card.scenario.trim() ? `\nscenario:\n${card.scenario.trim()}` : null,
              card.firstMes.trim() ? `\nfirst message:\n${preview(card.firstMes, 200)}` : null,
            ),
            details: {
              project_id: projectId,
              character_id: card.id,
              name: card.name,
              active: card.active,
              spec: card.specVersion,
            },
          };
        }

        if (args.action === "update") {
          const patch: CharacterPatch = {};
          if (args.name !== undefined) patch.name = args.name;
          if (args.description !== undefined) patch.description = args.description;
          if (args.personality !== undefined) patch.personality = args.personality;
          if (args.scenario !== undefined) patch.scenario = args.scenario;
          const fields = Object.keys(patch);
          requireFields(
            fields,
            "nothing to update: pass at least one of name / description / personality / scenario",
          );
          const updated = await store.updateCharacter(session, projectId, card.id, patch);
          return {
            action: args.action,
            summary: `Updated 「${updated.name}」 [${updated.id}]: ${fields.join(", ")}.`,
            details: { project_id: projectId, character_id: updated.id, updated: fields },
          };
        }

        if (args.action === "enable" || args.action === "disable") {
          const active = args.action === "enable";
          const updated = await store.updateCharacter(session, projectId, card.id, { active });
          return {
            action: args.action,
            summary: lines(
              `「${updated.name}」 [${updated.id}] is now ${active ? "participating in" : "excluded from"} the writing brief.`,
              active
                ? "Its description/personality/scenario will be injected by novel_context."
                : "Its setting is no longer injected (the card itself is kept).",
            ),
            details: { project_id: projectId, character_id: updated.id, active },
          };
        }

        if (args.action === "export") {
          const result = await store.exportCharacterPng(
            session,
            projectId,
            card.id,
            args.out_path ?? undefined,
          );
          return {
            action: args.action,
            summary: lines(
              `Exported 「${card.name}」 as a SillyTavern card PNG (${result.bytes} bytes):`,
              `  ${result.path}`,
              "chara + ccv3 chunks are both written, so SillyTavern reads it back losslessly.",
            ),
            details: { project_id: projectId, character_id: card.id, path: result.path },
          };
        }

        if (args.action === "remove") {
          const removed = await store.deleteCharacter(session, projectId, card.id, args.confirm);
          return {
            action: args.action,
            summary: lines(
              `Removed card 「${removed.name}」 [${removed.id}].`,
              "Note: lorebook entries merged from this card stay in the project — remove them with novel_lorebook if they are no longer wanted.",
            ),
            details: { project_id: projectId, character_id: removed.id },
          };
        }

        throw new Error(`unhandled action: ${args.action}`);
      },
    }),
  );
}
