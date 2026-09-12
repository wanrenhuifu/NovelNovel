/** 工具共用的输出形状与文本渲染 */
import type { ContentBlock, SchemaNode } from "../contract";
import type { NovelConfig, NovelStore } from "../store";
import type { Context, DefineTool } from "../contract";

export interface ToolDeps {
  ctx: Context;
  store: NovelStore;
  config: NovelConfig;
  defineTool: DefineTool;
}

/**
 * 统一的工具输出：
 * - `summary` 是模型看到的多行报告（render 直接输出它）
 * - `details` 给 PTC / 程序化消费（id、计数等结构化字段）
 */
export const TEXT_OUTPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", required: true, description: "The action that ran." },
    summary: { type: "string", required: true, description: "Human-readable report." },
    details: { type: "json", description: "Structured result data." },
  },
} as const satisfies SchemaNode;

export function textRender(
  _args: unknown,
  value: { summary: string },
): ContentBlock[] {
  return [{ type: "text", text: value.summary }];
}

/** 拼接非空行（null 自动跳过） */
export function lines(...parts: (string | null)[]): string {
  return parts.filter((part): part is string => Boolean(part && part.trim())).join("\n");
}

/** 章节正文预览：折叠空白并截断 */
export function preview(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * update 类 action 的空 patch 守卫：一个字段都没传时抛出带字段清单的错误。
 * hint 由调用方给出（就是模型看到的那句提示），保持各工具文案不变。
 */
export function requireFields(fields: string[], hint: string): void {
  if (fields.length === 0) throw new Error(hint);
}
