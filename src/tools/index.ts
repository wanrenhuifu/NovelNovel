/** 注册全部 novel_* 工具 */
import type { ToolDeps } from "./shared";
import { registerChapterTool } from "./chapter";
import { registerCharacterTool } from "./character";
import { registerContextTool } from "./context";
import { registerExportTool } from "./export";
import { registerLorebookTool } from "./lorebook";
import { registerPresetTool } from "./preset";
import { registerProjectTool } from "./project";
import { registerReviewTool } from "./review";
import { registerSkillTool } from "./skill";
import { registerSourceTool } from "./source";

export function registerTools(deps: ToolDeps): void {
  registerProjectTool(deps);
  registerChapterTool(deps);
  registerCharacterTool(deps);
  registerLorebookTool(deps);
  registerPresetTool(deps);
  registerSkillTool(deps);
  registerContextTool(deps);
  registerReviewTool(deps);
  registerExportTool(deps);
  registerSourceTool(deps);
}
