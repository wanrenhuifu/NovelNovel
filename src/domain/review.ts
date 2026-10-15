/**
 * 自动写作的自检（docs/design/auto-writer.md §5.2 第 4 步）：**本地硬门槛 + 子 agent 语义判定**。
 *
 * 这一层是纯逻辑，分三件事：
 *   1. 硬门槛（`hardCheckReview`）——字数/格式/与前章重复，本地算，毫秒级、零 token。
 *      不过就直接判不合格，**不起子 agent**（按 §2.1 的口径：能用程序判的别花模型往返）。
 *   2. 组装给子 agent 的材料（`buildReviewPrompt`）——正文 + goal + 全书大纲 + 前章尾部 +
 *      命中词条。**不含角色卡与预设**：文风与设定呈现不是自检的职责（那是写作侧技能的事）。
 *   3. 解析子 agent 的结论（`normalizeReviewVerdict`）——结构化输出优先，文本兜底。
 *      任何坏形状都返回 null，由调用方降级，绝不猜。
 *
 * 权限口径（§8.1 的反面，但方向一致）：子 agent **只判定 + 给建议**，写权留在前台。
 */
import type { LoreEntry } from "./types";
import { countWords } from "./utils";
import { fenceFor } from "./prompt";

/** 硬门槛的阈值（全部来自插件配置，见 src/index.ts 的 resolveConfig） */
export interface HardCheckOptions {
  /** 正文字数下限；0 = 不设下限（不误伤短篇/小品） */
  minChapterChars: number;
  /** 与前一章尾部连续重合多少字算「重复」 */
  maxRepeatRunChars: number;
  /** 是否检查正文里混进的标题/元话语 */
  formatChecks: boolean;
}

export interface HardCheckResult {
  passed: boolean;
  /** 按「字数 = 汉字 + 西文词」口径统计，与全书其它地方一致 */
  chars: number;
  issues: string[];
}

/** 每章最多报几条问题：问题清单是给模型读的，报 30 条只会淹没真正要改的那两条 */
const MAX_ISSUES = 8;

function flat(text: string, max = 60): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/**
 * 正文里不该出现的东西。只报**无歧义**的三种，宁可漏报也不误报：
 * Markdown 标题、代码围栏、`字数：1234` 这类元话语行。
 * （`（本章完）` 是中文网文的常规收尾，**有意不报**。）
 */
function formatIssues(text: string): string[] {
  const issues: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const at = `line ${i + 1}`;
    if (/^[ \t]{0,3}#{1,6}[ \t]+\S/.test(line)) {
      issues.push(`${at} is a Markdown heading: "${flat(line)}" — a chapter body holds story text only`);
    } else if (/^[ \t]{0,3}(```|~~~)/.test(line)) {
      issues.push(`${at} opens a code fence: "${flat(line)}" — prose must not carry formatting fences`);
    } else if (/(字数|总计|全文字数|写作说明|以上是)[ \t]*[:：]/.test(line)) {
      issues.push(`${at} is meta commentary: "${flat(line)}" — no notes or word counts inside a chapter`);
    }
    if (issues.length >= MAX_ISSUES) break;
  }
  return issues;
}

/**
 * 与前一章尾部的最长连续重合片段。
 *
 * 用「等长窗口 + 集合」而不是二维 DP：正文几千字，窗口法在内存与时间上都便宜得多，
 * 而这里只需要**是否存在一段够长的重合**和一个可信的长度，不需要真的求出 LCS。
 * 命中的那个窗口再向后扩展，报出的是该次重合的实际长度（是下界，不是精确的全局最长——
 * 判「有没有大段重复」够用，报「重复了 137 字」这种精确数字本来也没意义）。
 */
export function longestRepeatRun(text: string, prev: string, windowSize: number): {
  length: number;
  fragment: string;
} {
  if (windowSize <= 0 || prev.length < windowSize || text.length < windowSize) {
    return { length: 0, fragment: "" };
  }
  const windows = new Set<string>();
  for (let i = 0; i + windowSize <= prev.length; i++) windows.add(prev.slice(i, i + windowSize));
  let best = { length: 0, fragment: "" };
  for (let i = 0; i + windowSize <= text.length; i++) {
    const window = text.slice(i, i + windowSize);
    if (!windows.has(window)) continue;
    const at = prev.indexOf(window);
    let end = windowSize;
    // 向后扩展：报出这次重合的真实长度，而不是窗口大小
    while (i + end < text.length && at + end < prev.length && text[i + end] === prev[at + end]) end++;
    if (end > best.length) best = { length: end, fragment: text.slice(i, i + end) };
  }
  return best;
}

/**
 * 本地硬门槛。`passed === false` 时调用方**不应该**再起子 agent（省一次模型往返）。
 * `prevText` 给上一章的尾部摘录（没有上一章就传空串）。
 */
export function hardCheckReview(
  text: string,
  prevText: string,
  options: HardCheckOptions,
): HardCheckResult {
  const chars = countWords(text);
  const issues: string[] = [];
  if (!text.trim()) {
    return { passed: false, chars: 0, issues: ["the chapter body is empty"] };
  }
  if (options.minChapterChars > 0 && chars < options.minChapterChars) {
    issues.push(
      `the chapter is ${chars} words, below the configured minimum of ${options.minChapterChars} — ` +
        "continue the scene instead of ending it here",
    );
  }
  if (options.formatChecks) issues.push(...formatIssues(text));
  const run = longestRepeatRun(text, prevText, options.maxRepeatRunChars);
  if (run.length > 0) {
    issues.push(
      `it repeats a ${run.length}-character passage from the end of the previous chapter: ` +
        `"${flat(run.fragment, 80)}" — retell it in new words or cut it`,
    );
  }
  return { passed: issues.length === 0, chars, issues: issues.slice(0, MAX_ISSUES) };
}

/** 子 agent 必须按这个形状作答（`ctx.subagents` 的 outputSchema 是**标准 JSON Schema**） */
export const REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "issues"],
  properties: {
    verdict: {
      type: "string",
      enum: ["pass", "fail"],
      description: "pass when the chapter is ready to keep; fail when it must be revised.",
    },
    issues: {
      type: "array",
      description: "One concrete, fixable problem per entry. Empty when verdict is pass.",
      items: { type: "string" },
    },
    summary: {
      type: "string",
      description:
        "One short paragraph on what actually happens in this chapter, for later retrieval. Not a critique.",
    },
    lore: {
      type: "array",
      description: "New settings/story facts this chapter establishes, for the author to file.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "content"],
        properties: {
          name: { type: "string" },
          keys: {
            type: "string",
            description: "Comma-separated trigger keywords; empty means always injected.",
          },
          content: { type: "string" },
        },
      },
    },
  },
} as const;

export interface ReviewLoreSuggestion {
  name: string;
  keys: string;
  content: string;
}

export interface ReviewVerdict {
  verdict: "pass" | "fail";
  issues: string[];
  summary: string;
  lore: ReviewLoreSuggestion[];
}

/** 词条建议与问题清单的条数上限：这些文本会进前台模型的上下文，不设上限等于让它淹掉 */
const MAX_LORE_SUGGESTIONS = 8;

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeLore(value: unknown): ReviewLoreSuggestion[] {
  if (!Array.isArray(value)) return [];
  const out: ReviewLoreSuggestion[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const name = asText(record.name);
    const content = asText(record.content);
    // 没名字或没内容的建议没有落盘价值，直接丢（不猜、不补）
    if (!name || !content) continue;
    out.push({ name, keys: asText(record.keys), content });
    if (out.length >= MAX_LORE_SUGGESTIONS) break;
  }
  return out;
}

/**
 * 把子 agent 的返回归一成判定。**只认两种 verdict**；其余形状一律返回 null。
 *
 * 为什么允许字符串：结构化输出要求子 agent 把 `structured_output` 调对，
 * 而模型有可能改用一个纯文本 JSON 作答。那种情况不该整条链路判「失败」——
 * 兜底把文本里的最后一个 JSON 对象抠出来试一次，成功就用。
 */
export function normalizeReviewVerdict(value: unknown): ReviewVerdict | null {
  if (typeof value === "string") {
    const extracted = extractJsonObject(value);
    return extracted === null ? null : normalizeReviewVerdict(extracted);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const verdict = asText(record.verdict).toLowerCase();
  if (verdict !== "pass" && verdict !== "fail") return null;
  const issues = Array.isArray(record.issues)
    ? record.issues.map(asText).filter(Boolean).slice(0, MAX_ISSUES)
    : [];
  const summary = asText(record.summary);
  // `verdict: pass` 却带着问题清单是自相矛盾的：子 agent 只有在真的没问题时才该说 pass，
  // 否则前台拿到一个「过了」却又要改的指令。按"有问题就是不合格"收口，以问题清单为准。
  const normalized: "pass" | "fail" = issues.length > 0 ? "fail" : verdict;
  return { verdict: normalized, issues, summary, lore: normalizeLore(record.lore) };
}

/**
 * 从一段文本里抠出 JSON 对象。候选顺序：整段 → 代码围栏 → 每一个**成对**的大括号块，
 * 从后往前试（模型习惯把结论放在最后）。
 *
 * 为什么要做成对匹配而不是 `indexOf("{")…lastIndexOf("}")`：后面那招在两个对象之间会切出
 * `{…} 说明 {…}` 这种非法片段，于是明明有一个合法的结论却解析不出来。字符串里的括号与转义
 * 也一并跳过——JSON 里的文案（比如台词）本来就可能带花括号。
 */
function balancedObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      } else if (depth < 0) {
        depth = 0;
      }
    }
  }
  return out;
}

export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const attempts: string[] = [];
  if (trimmed.startsWith("{")) attempts.push(trimmed);
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) attempts.push(match[1]);
  attempts.push(...balancedObjects(trimmed));
  for (const candidate of attempts.reverse()) {
    try {
      const parsed: unknown = JSON.parse(candidate.trim());
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed;
    } catch {
      // 下一个候选
    }
  }
  return null;
}

export interface ReviewPromptInput {
  projectTitle: string;
  chapterTitle: string;
  /** 大纲第三层：这一章要推进什么（可能为空） */
  goal: string;
  /** 大纲第一层：全书梗概（可能为空） */
  outline: string;
  /** 本次命中、随简报一起注入的词条 */
  lore: LoreEntry[];
  /** 前一章尾部摘录（可能为空） */
  prevTail: string;
  /** 前一章的标题（有 prevTail 时用于标注来源） */
  prevTitle: string;
  /** 待判定的正文 */
  text: string;
}

function loreBlock(entries: LoreEntry[]): string {
  return entries
    .map((entry) => `### ${entry.name.trim() || entry.keys}\n${entry.content.trim()}`)
    .join("\n\n");
}

/**
 * 组装子 agent 的材料与判据。
 *
 * 为什么给这些、不给那些（§2.1 的判据）：判据要用的（goal / 大纲 / 前文 / 设定）必须给全，
 * 否则判「有没有推进 goal」「跟设定矛不矛盾」就是空话；角色卡与预设的 system/story_string
 * 是**文风**材料，自检不管文风，给了纯属烧 token。
 *
 * 正文一律套围栏（长度按正文里的反引号自适应）：正文里的 ``` 会提前闭合围栏，把后面的
 * 文本挤到栏外当指令读——那是一条提示词注入路径。
 */
export function buildReviewPrompt(input: ReviewPromptInput): string {
  const parts: string[] = [];
  parts.push(
    "You are reviewing one chapter of a novel before it is kept. You cannot change the text and you have no tools other than the structured-report tool:",
    "judge it and report concrete, fixable problems.",
    "",
    "Report `fail` only for problems that must be fixed before the chapter is kept:",
    "- it does not advance what this chapter is supposed to advance (see 本章目标);",
    "- it contradicts the whole-book outline, the setting entries, or the previous chapter's ending;",
    "- it is a broken draft (cuts off, repeats itself, drifts out of character, character/place names inconsistent with the material below).",
    "Do not fail a chapter for style preferences, and do not invent facts that the material below does not contain.",
    "For every issue, say what is wrong and what to do about it — the author will revise it themselves.",
    "",
    `Novel: 《${input.projectTitle}》`,
    `Chapter: ${input.chapterTitle}`,
  );
  if (input.outline) {
    parts.push("", "## 全书大纲 (whole-book outline — every chapter must stay consistent with it)", input.outline);
  }
  if (input.goal) {
    parts.push("", "## 本章目标 (what this chapter must advance)", input.goal);
  }
  if (input.lore.length > 0) {
    parts.push("", "## 相关设定词条 (setting entries relevant to this chapter)", loreBlock(input.lore));
  }
  if (input.prevTail.trim()) {
    const tail = input.prevTail.trim();
    const fence = fenceFor(tail);
    parts.push(
      "",
      "## 上一章结尾 (the end of the previous chapter — the chapter under review must continue from here)",
      `【${input.prevTitle.trim() || "previous chapter"}】`,
      fence,
      tail,
      fence,
    );
  }
  const body = input.text.trim();
  const fence = fenceFor(body);
  parts.push(
    "",
    "## 待审正文 (the chapter under review; the local length/format/duplication checks already passed)",
    fence,
    body,
    fence,
    "",
    "Now report your verdict with the structured-report tool: verdict, one issue per fixable problem",
    "(empty when it passes), a short retrieval summary of what happens, and any new settings this chapter establishes.",
  );
  return parts.join("\n");
}
