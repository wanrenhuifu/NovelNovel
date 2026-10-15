/**
 * 候选池筛选（第 6 步的可选一半，docs/design/auto-writer.md §8.1）。
 *
 * 本地负责**召回**（关键词命中，保证不漏），子 agent 负责**筛选**（保证不糊），
 * 而权限的方向是不对称的、刻意如此：
 *
 * > **只能删，不能加。** 返回的是「这些候选里哪些不要」，不是「要哪些」。
 *
 * 两个理由：
 * - 漏注入会丢设定（严重），糊注入只是浪费上下文（次要）。所以默认答案是"全都留着"——
 *   筛不出结论、返回坏形状、服务不在，统统退回本地召回的结果，绝不因为一次失败的筛选
 *   把设定丢掉。
 * - 返回 `keep` 的话，"模型懒得看就回一个空数组"会静默清空设定入口；返回 `drop` 时
 *   空数组的含义正好是"一条都别删"。同一个坏行为，另一种接口下是无害的。
 */
import type { LoreEntry } from "./types";

/** 子 agent 必须按这个形状作答（`keep` 的反面：只报要删的） */
export const LORE_FILTER_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["drop"],
  properties: {
    drop: {
      type: "array",
      description:
        "ids copied exactly from the candidate list that are NOT relevant to this chapter. " +
        "Use an empty array when every candidate is relevant. Never invent ids.",
      items: { type: "string" },
    },
  },
} as const;

export interface LoreFilterInput {
  projectTitle: string;
  chapterTitle: string;
  /** 大纲第三层：这一章要推进什么（可能为空） */
  goal: string;
  /** 已经命中的候选条目（本地召回的结果） */
  candidates: LoreEntry[];
  /** 用于判断相关性的正文/上下文摘要（截断过的，别把整章塞进提示词） */
  context: string;
}

function flat(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/**
 * 候选池筛选的提示词：只问"哪些跟这一章无关"。
 *
 * 候选内容按**截断预览**给（而不是全文）：这一步判的是「这条设定跟这一章的场景有关吗」，
 * 看开头就够了，而给全文会让这一步本身变成一次大 token 支出——那就背离了它省 token 的初衷。
 */
export function buildLoreFilterPrompt(input: LoreFilterInput): string {
  const candidates = input.candidates
    .map((entry) => `- id=${entry.id} | ${entry.name || entry.keys}${entry.keys ? ` [${entry.keys}]` : ""}: ${flat(entry.content, 200)}`)
    .join("\n");
  return [
    "You are triaging a novel project's setting entries for one chapter.",
    "The list below was recalled mechanically by keyword matching, so it over-delivers: decide which entries are NOT relevant to this chapter.",
    "",
    "Rules:",
    "- Report only ids copied from the list. Never invent an id, never comment on an entry's quality.",
    "- Drop an entry only when knowing it cannot change how this chapter is written.",
    "- When in doubt, keep it: a missing setting costs continuity, an extra one only costs context.",
    "- If all candidates look relevant, return an empty list.",
    "",
    `Novel: 《${input.projectTitle}》`,
    `Chapter: ${input.chapterTitle}`,
    ...(input.goal ? [`本章目标: ${input.goal}`] : []),
    "",
    "## 候选设定条目 (candidates)",
    candidates,
    "",
    "## 本章上下文 (what this chapter is about)",
    flat(input.context, 1200),
    "",
    "Report your answer with the structured-report tool: the `drop` list.",
  ].join("\n");
}

/**
 * 归一筛选结论：返回要删的 id 集合，或 null（= 退回"一条都别删"）。
 *
 * 返回的 id 必须先落在候选集里：模型拼错 id、抄了别的条目、或返回一个候选池外的 id，
 * 都按"没有这条"处理——**绝不允许它影响候选池之外的东西**（那是这条权限边界的要点）。
 */
export function normalizeLoreFilter(
  value: unknown,
  candidates: readonly LoreEntry[],
): { dropped: Set<string>; unknown: string[] } | null {
  const record =
    typeof value === "string"
      ? (() => {
          const at = value.indexOf("{");
          const end = value.lastIndexOf("}");
          if (at < 0 || end <= at) return null;
          try {
            const parsed: unknown = JSON.parse(value.slice(at, end + 1));
            return typeof parsed === "object" && parsed !== null ? (parsed as unknown) : null;
          } catch {
            return null;
          }
        })()
      : value;
  if (typeof record !== "object" || record === null) return null;
  const drop = (record as { drop?: unknown }).drop;
  if (!Array.isArray(drop)) return null;
  const known = new Set(candidates.map((entry) => entry.id));
  const dropped = new Set<string>();
  const unknown: string[] = [];
  for (const item of drop) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id) continue;
    if (known.has(id)) dropped.add(id);
    else unknown.push(id);
  }
  return { dropped, unknown };
}
