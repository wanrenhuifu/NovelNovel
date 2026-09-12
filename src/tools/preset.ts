/**
 * novel_preset：写作预设（SillyTavern 预设 JSON 导入 / 手写 / 激活）。
 * 预设决定系统提示词与设定区块的组装方式；instruct 类预设只控制对话格式，
 * 由 harness 自己的消息结构承担，因此只存档不参与组装。
 */
import type { PresetPatch } from "../store";
import { lines, preview, requireFields, TEXT_OUTPUT, textRender, type ToolDeps } from "./shared";

export function registerPresetTool({ ctx, store, defineTool }: ToolDeps): void {
  ctx.tools.register(
    defineTool({
      name: "novel_preset",
      description: lines(
        "Manage the writing presets that shape the assembled system prompt.",
        "action=import reads a SillyTavern preset JSON (bare sysprompt/context/instruct or a combined envelope);",
        "action=add writes one by hand (system_prompt replaces the default opening, story_string replaces the whole setting block);",
        "action=activate applies a preset to the project, action=deactivate falls back to the built-in default.",
        "The assembled result is visible via novel_context.",
      ),
      parameters: {
        action: {
          type: "string",
          required: true,
          enum: ["list", "import", "add", "update", "activate", "deactivate", "remove"],
          description: "What to do.",
        },
        project: {
          type: "string",
          description: "Project id, title, or 1-based index. Defaults to the current project.",
        },
        preset: {
          type: "string",
          description: "Preset id or name. Required for update/activate/remove.",
        },
        path: {
          type: "string",
          description: "Path to the preset .json file (action=import).",
        },
        name: { type: "string", description: "Preset name (action=add/update)." },
        system_prompt: {
          type: "string",
          description:
            "System prompt template. Supports {{char}} / {{user}} macros. Required for action=add when story_string is absent.",
        },
        story_string: {
          type: "string",
          description:
            "Context template replacing the default setting block. Supports {{#if var}}/{{else}}/{{trim}} and the variables title, synopsis, worldbuilding, system, description, personality, scenario, wiBefore.",
        },
      },
      output: { schema: TEXT_OUTPUT, render: textRender },
      isConcurrencySafe: (args) => args.action === "list",
      async execute(args, exec) {
        const session = store.sessionOf(exec);
        const projectId = await store.resolveProjectId(session, args.project);

        if (args.action === "list") {
          const file = await store.readPresets(session, projectId);
          const active = store.activePreset(file);
          const summary = lines(
            file.presets.length === 0
              ? "No preset yet — the built-in default system prompt is in use. Import one with novel_preset action=import path=<preset.json>."
              : `Presets (${file.presets.length})${active ? `, active: ${active.name}` : ", none active (built-in default)"}:`,
            ...file.presets.map((preset) =>
              lines(
                `- ${preset.name} [${preset.id}] · kind=${preset.kind}` +
                  (preset.id === file.activePresetId ? " · ACTIVE" : ""),
                preset.systemPrompt.trim() ? `  system: ${preview(preset.systemPrompt, 90)}` : null,
                preset.storyString.trim() ? `  story_string: ${preview(preset.storyString, 90)}` : null,
              ),
            ),
          );
          return {
            action: args.action,
            summary,
            details: {
              project_id: projectId,
              active_preset_id: file.activePresetId,
              presets: file.presets.map((preset) => ({
                id: preset.id,
                name: preset.name,
                kind: preset.kind,
              })),
            },
          };
        }

        if (args.action === "import") {
          if (!args.path?.trim()) throw new Error("path is required for novel_preset action=import");
          const text = await store.readTextFile(args.path.trim(), session);
          const result = await store.importPreset(session, projectId, text);
          return {
            action: args.action,
            summary: lines(
              `Imported preset 「${result.preset.name}」 [${result.preset.id}] (kind=${result.preset.kind}).`,
              result.activated ? "It is now the active preset." : null,
              result.replacedActive
                ? "It replaced the active preset of the same name, which stays active."
                : null,
              result.note ? `Note: ${result.note}` : null,
            ),
            details: {
              project_id: projectId,
              preset_id: result.preset.id,
              kind: result.preset.kind,
              activated: result.activated,
              replaced_active: result.replacedActive,
            },
          };
        }

        if (args.action === "add") {
          if (!args.name?.trim()) throw new Error("name is required for novel_preset action=add");
          if (!args.system_prompt?.trim() && !args.story_string?.trim()) {
            throw new Error(
              "pass at least one of system_prompt (replaces the opening) or story_string (replaces the setting block)",
            );
          }
          const { preset, activated } = await store.addPreset(session, projectId, {
            name: args.name,
            ...(args.system_prompt !== undefined ? { systemPrompt: args.system_prompt } : {}),
            ...(args.story_string !== undefined ? { storyString: args.story_string } : {}),
          });
          return {
            action: args.action,
            summary: lines(
              `Added preset 「${preset.name}」 [${preset.id}] (kind=${preset.kind}).`,
              activated
                ? "It is now the active preset (it was the first one)."
                : "Activate it with novel_preset action=activate.",
            ),
            details: { project_id: projectId, preset_id: preset.id, kind: preset.kind, activated },
          };
        }

        if (args.action === "deactivate") {
          const file = await store.activatePreset(session, projectId, null);
          return {
            action: args.action,
            summary: lines(
              "Preset deactivated — the built-in default system prompt is used again.",
              `${file.presets.length} preset(s) stay archived and can be re-activated.`,
            ),
            details: { project_id: projectId, active_preset_id: null },
          };
        }

        if (!args.preset?.trim()) {
          throw new Error(`preset is required for novel_preset action=${args.action}`);
        }
        const found = await store.resolvePreset(session, projectId, args.preset);

        if (args.action === "activate") {
          await store.activatePreset(session, projectId, found.id);
          return {
            action: args.action,
            summary: lines(
              `Activated preset 「${found.name}」 [${found.id}] (kind=${found.kind}).`,
              "novel_context now assembles the system prompt through it.",
            ),
            details: { project_id: projectId, preset_id: found.id },
          };
        }

        if (args.action === "update") {
          const patch: PresetPatch = {};
          if (args.name !== undefined) patch.name = args.name;
          if (args.system_prompt !== undefined) patch.systemPrompt = args.system_prompt;
          if (args.story_string !== undefined) patch.storyString = args.story_string;
          const fields = Object.keys(patch);
          requireFields(fields, "nothing to update: pass name / system_prompt / story_string");
          const updated = await store.updatePreset(session, projectId, found.id, patch);
          return {
            action: args.action,
            summary: `Updated preset 「${updated.name}」 [${updated.id}]: ${fields.join(", ")}.`,
            details: { project_id: projectId, preset_id: updated.id, updated: fields },
          };
        }

        if (args.action === "remove") {
          const presets = await store.readPresets(session, projectId);
          const removed = await store.removePreset(session, projectId, found.id);
          return {
            action: args.action,
            summary: lines(
              `Removed preset 「${removed.name}」 [${removed.id}].`,
              presets.activePresetId === removed.id
                ? "It was active, so the built-in default is used now."
                : null,
            ),
            details: { project_id: projectId, preset_id: removed.id },
          };
        }

        throw new Error(`unhandled action: ${args.action}`);
      },
    }),
  );
}
