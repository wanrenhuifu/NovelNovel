/** 注册全部 novel_* 工具 */
import type { ToolDeps } from "./shared";
import { registerChapterTool } from "./chapter";
import { registerCharacterTool } from "./character";
import { registerContextTool } from "./context";
import { registerExportTool } from "./export";
import { registerLorebookTool } from "./lorebook";
import { registerPresetTool } from "./preset";
import { registerProjectTool } from "./project";

export function registerTools(deps: ToolDeps): void {
  registerProjectTool(deps);
  registerChapterTool(deps);
  registerCharacterTool(deps);
  registerLorebookTool(deps);
  registerPresetTool(deps);
  registerContextTool(deps);
  registerExportTool(deps);
}
