/**
 * dsh-novelnovel 插件入口。
 *
 * 一行配置同时挂起：作品/章节/角色卡/世界书/预设的文件存储、7 个 novel_* 工具、
 * 2 个技能、/novel 斜杠命令与一小段系统提示词。
 * 全部通过 ctx 注册，插件卸载时由 Cordis 自动撤销。
 */
import type { Context, DefineTool } from "./contract";
import { registerNovelCommand } from "./command";
import { loadHarnessModule } from "./harness";
import { registerSkills } from "./skills";
import { NovelStore, type NovelConfig } from "./store";
import { lines } from "./tools/shared";
import { registerTools } from "./tools/index";

/** 加载 harness 真品 defineTool（解析顺序见 harness.ts 的说明） */
const { defineTool } = await loadHarnessModule<{ defineTool: DefineTool }>(
  "@deepseek-ai/dsh-tools",
);

export const name = "novelnovel";

/** 硬依赖：工具注册表与文件系统；技能/命令/系统提示词按可用性软挂载 */
export const inject = ["tools", "fs"];

export interface PluginConfig {
  /** 数据根目录（相对会话工作目录）。默认 .novelnovel */
  dataDir?: string;
  /** novel_context 默认携带的前文章节数 */
  defaultPrevChapterCount?: number;
  /** 每个前文章节默认摘取的尾部字数 */
  defaultPrevChapterChars?: number;
  /** 当前章默认摘取的尾部字数 */
  defaultRecentChars?: number;
}

/** 配置校验：非法配置在加载期直接抛错（不静默取默认值） */
export function resolveConfig(raw: PluginConfig = {}): NovelConfig {
  const dataDir = raw.dataDir?.trim() || ".novelnovel";
  const escaped =
    dataDir.startsWith("/") ||
    /^[a-zA-Z]:/.test(dataDir) ||
    dataDir.split(/[\\/]/).includes("..");
  if (escaped) {
    throw new Error(
      "dsh-novelnovel: dataDir must stay inside the workspace (relative path, no '..')",
    );
  }
  const count = (value: number | undefined, fallback: number, field: string): number => {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`dsh-novelnovel: ${field} must be a non-negative integer`);
    }
    return value;
  };
  return {
    dataDir: dataDir.replace(/[\\/]+$/, ""),
    defaultPrevChapterCount: count(raw.defaultPrevChapterCount, 1, "defaultPrevChapterCount"),
    defaultPrevChapterChars: count(raw.defaultPrevChapterChars, 1500, "defaultPrevChapterChars"),
    defaultRecentChars: count(raw.defaultRecentChars, 3000, "defaultRecentChars"),
  };
}

export function apply(ctx: Context, rawConfig?: PluginConfig): void {
  const config = resolveConfig(rawConfig);
  const store = new NovelStore(ctx, config);

  registerTools({ ctx, store, config, defineTool });

  ctx.inject(["skills"], (skillCtx) => {
    void registerSkills(skillCtx).catch((error: unknown) => {
      ctx.logger.warn(`dsh-novelnovel: skills unavailable (${(error as Error).message})`);
    });
  });

  ctx.inject(["commands"], (commandCtx) => {
    registerNovelCommand(commandCtx, store);
  });

  ctx.inject(["systemPrompt"], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: "novelnovel:workspace",
      // 紧随首方工具说明（TOOL_* 到 2900），早于 TOOLS_SDK(5000)
      order: 4500,
      // 用 thunk 读 config：数据目录可被 profile 覆盖，提示词要跟着变
      text: () =>
        lines(
          "## Novel writing in this workspace",
          `The \`novel_*\` tools manage NovelNovel projects stored in this workspace (data directory \`${config.dataDir}/\`).`,
          "When the user asks to write, continue, revise, outline or export fiction, use them instead of editing the novel files by hand:",
          "1. `novel_project action=show` (or `action=list`) loads the project; `action=create` starts a new novel.",
          "2. `novel_context chapter=<ref>` returns the author's brief for that chapter (worldbuilding, keyword-matched lorebook entries, participating character cards, active preset, previous-chapter excerpts). Treat it as authoritative for setting, characterisation and style.",
          "3. Write the prose, then land it with `novel_chapter action=append` (`action=write` replaces a chapter).",
          "4. Record new facts as they appear: `novel_lorebook action=add` for world settings, `novel_character action=import` for SillyTavern cards, `novel_preset` for prompt presets.",
          "Prose must be written in the project's language (Chinese by default) and must contain only the story text — no explanations, headings or meta commentary.",
        ),
    });
  });

  ctx.logger.info(`dsh-novelnovel: ready (dataDir=${config.dataDir})`);
}
