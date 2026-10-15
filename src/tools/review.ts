/**
 * novel_review：一章的**判定闸**（自动写作闭环的第 4 步，docs/design/auto-writer.md §5.2）。
 *
 * 两层，谁便宜谁先跑：
 *   1. **本地硬门槛**（字数 / 格式 / 与前一章重复）——毫秒级、零 token。不过就直接判不合格，
 *      **不起子 agent**（§2.1：能用程序判的别花模型往返）。
 *   2. **一次性 spawn 子 agent 的语义判定**——推进 goal 了吗、与大纲/设定/前文矛盾吗。
 *      它只读材料、只回结构化结论，**不能碰正文**（§8.1 的权限方向：后台只能做减法）。
 *
 * 四条刻意的口径：
 * - 结论是三值的：`pass` / `fail` / **`inconclusive`**。最后一种（本地过了但语义没跑成）
 *   既不能写 pass（在数据文件里说谎），也不能写 fail（推动无意义的重写），
 *   所以它在报告里明说"**这不是通过**，自己判连续性与任务契合度"。
 * - **判定通过才写 summary**：判不合格的正文马上要重写，此时落一份摘要是给未来留假信息。
 * - **基础设施故障不计数也不清零**：没有 subagents 服务、子 agent 报错、返回坏形状——
 *   都不是"这一章写坏了"（§2.2：停下来的条件是正文没写出来）。
 * - **连败计数落盘**（`ChapterMeta.review`）：模型自己数记不住，数丢了就是无限重写同一章。
 */
import {
  REVIEW_OUTPUT_SCHEMA,
  buildReviewPrompt,
  hardCheckReview,
  normalizeReviewVerdict,
  type ReviewLoreSuggestion,
} from "../domain/review";
import { rankLoreEntries } from "../domain/prompt";
import { countWords } from "../domain/utils";
import type { ChapterMeta, ChapterReview } from "../types";
import { lines, preview, TEXT_OUTPUT, textRender, type ToolDeps } from "./shared";
import { runStructuredSubagent } from "./subagent";

/** 子 agent 的角色说明（模型可见，所以是英文）：把"只判定、不重写"说到位 */
const REVIEW_PERSONA =
  "You are the continuity reviewer of a NovelNovel project: you judge one chapter against the material " +
  "you are given and report concrete, fixable problems. You never rewrite the prose and you never ask " +
  "questions. Style and word choice are not yours to judge — task fit (does the chapter advance its goal), " +
  "continuity (does it contradict the outline, the setting entries or the previous chapter) and draft " +
  "integrity (does it cut off, repeat itself, drift out of character) are. " +
  "You have no tools other than the structured-report tool: report your verdict with it and stop.";

/** 三值判定：见文件头的第一条口径 */
type Gate = "pass" | "fail" | "inconclusive";

interface GateResult {
  gate: Gate;
  issues: string[];
  summary: string;
  lore: ReviewLoreSuggestion[];
}

const GATE_TAG: Record<Gate, string> = { pass: "PASS", fail: "FAIL", inconclusive: "INCONCLUSIVE" };

function resultSummary(input: {
  chapter: ChapterMeta;
  projectTitle: string;
  result: GateResult;
  attempts: number;
  maxAttempts: number;
  stop: boolean;
  semantic: ChapterReview["semantic"];
  chars: number;
  semanticReason?: string;
  recorded: boolean;
  recordError?: string;
  summaryStored: boolean;
  truncatedLore: string[];
}): string {
  const { chapter, result, attempts, maxAttempts } = input;
  const out: string[] = [
    `${GATE_TAG[result.gate]} · 《${input.projectTitle}》 / ${chapter.title} [${chapter.id}] · ${input.chars} words`,
    maxAttempts > 0
      ? `attempt ${attempts} of ${maxAttempts} (consecutive failures on this chapter)`
      : `consecutive failures on this chapter: ${attempts} (no limit configured)`,
  ];
  if (input.semantic === "ok") out.push("semantic check: sub-agent (read-only; goal + continuity)");
  else if (input.semantic === "local-only") out.push("semantic check: skipped (local checks only)");
  else if (input.semantic === "unavailable")
    out.push(`semantic check: UNAVAILABLE — ${input.semanticReason ?? "no sub-agent service"}`);
  else out.push(`semantic check: FAILED — ${input.semanticReason ?? "no usable conclusion"}`);

  if (result.issues.length > 0) {
    out.push("issues:");
    result.issues.forEach((issue, index) => out.push(`  ${index + 1}. ${issue}`));
  }
  if (input.stop) {
    out.push(
      "",
      `STOP: this chapter has failed ${attempts} times in a row. Do not rewrite it again — report the issues`,
      "above to the author and let them decide (change the goal, fix the outline, or write it themselves).",
    );
  } else if (result.gate === "fail") {
    out.push("", "Revise the chapter against these issues, then call novel_review again.");
  } else if (result.gate === "inconclusive") {
    out.push(
      "",
      "This is NOT a pass: the local checks went through, but no semantic verdict was reached, so nobody has",
      "checked task fit or continuity. Judge those yourself from the brief before moving on.",
    );
  } else {
    out.push("", "Keep the chapter and move on to the next one.");
  }
  if (input.summaryStored) out.push(`retrieval summary stored: ${preview(result.summary, 120)}`);
  if (result.gate === "pass" && !result.summary && input.semantic === "ok") {
    out.push("retrieval summary: none returned by the sub-agent");
  }
  if (result.lore.length > 0) {
    out.push(
      "",
      "new settings this chapter establishes (file them with novel_lorebook action=add if later chapters must respect them):",
    );
    for (const entry of result.lore) {
      out.push(
        `  - ${entry.name}${entry.keys ? ` [${entry.keys}]` : " (always-on)"}: ${preview(entry.content, 120)}`,
      );
    }
  }
  if (input.truncatedLore.length > 0) {
    out.push(
      "",
      `⚠️ ${input.truncatedLore.length} more setting entr(ies) matched this chapter but were left out of the check ` +
        `by the injection limits: ${input.truncatedLore.join(", ")}. Read them if the verdict looks uninformed.`,
    );
  }
  if (!input.recorded) {
    out.push("", `⚠️ the review record could not be stored (${input.recordError ?? "unknown reason"})`);
  }
  return out.join("\n");
}

export function registerReviewTool({ ctx, store, config, defineTool, subagents }: ToolDeps): void {
  ctx.tools.register(
    defineTool({
      name: "novel_review",
      description: lines(
        "Review one chapter of the current novel project before it is kept.",
        "Runs the local checks first (length floor, stray headings/meta lines, long passages repeated from the previous chapter) and stops there if they fail;",
        "otherwise a read-only sub-agent judges whether the chapter advances its goal and stays consistent with the whole-book outline, the setting entries and the previous chapter's ending.",
        "Returns a verdict — pass / fail / inconclusive — concrete issues to fix, a retrieval summary and the new settings the chapter establishes. It never rewrites prose: revision is yours.",
        "Pass text= to review a draft before landing it (preferred: nothing reaches the disk until it passes); omit it to review the chapter's current body.",
        "inconclusive means the local checks passed but no semantic verdict was reached (no sub-agent available, or it failed) — that is NOT a pass.",
        "After revising, call it again. When it says STOP the chapter has failed too many times in a row: report the issues to the author instead of rewriting again.",
      ),
      parameters: {
        chapter: {
          type: "string",
          required: true,
          description:
            "Chapter to review: id, 1-based number, or title (exact or unique partial). " +
            "It supplies the goal, the whole-book outline and the previous chapter used as review material.",
        },
        project: {
          type: "string",
          description: "Project id, title, or 1-based index. Defaults to the current project.",
        },
        text: {
          type: "string",
          description:
            "Draft prose to review instead of the chapter's current body. Use it to check a chapter before novel_chapter action=append.",
        },
        local_only: {
          type: "boolean",
          description:
            "Run only the local checks (length, format, duplication) — no sub-agent, no token cost. The verdict is then inconclusive, not pass.",
        },
        write_summary: {
          type: "boolean",
          description:
            "Store the returned retrieval summary on the chapter (default true). Only a passing chapter gets one: a summary of text that is about to be rewritten is false information.",
        },
      },
      output: { schema: TEXT_OUTPUT, render: textRender },
      // 会写 summary 与自检记录，不是只读工具
      async execute(args, exec) {
        const session = store.sessionOf(exec);
        const projectId = await store.resolveProjectId(session, args.project);
        const chapter = await store.readChapter(session, projectId, args.chapter);
        const project = await store.readProject(session, projectId);
        const isDraft = args.text !== undefined && args.text.trim().length > 0;
        const text = isDraft ? args.text! : chapter.content;

        // 前文材料与写作简报同一口径：最近一章的尾部，长度沿用 defaultPrevChapterChars
        const prevResult = await store.previousExcerpts(
          session,
          projectId,
          chapter.id,
          1,
          config.defaultPrevChapterChars,
        );
        const prev = prevResult.excerpts.at(-1);
        const prevText = prev?.text ?? "";

        const hard = hardCheckReview(text, prevText, {
          minChapterChars: config.minChapterChars,
          maxRepeatRunChars: config.maxRepeatRunChars,
          formatChecks: config.reviewFormatChecks,
        });

        const priorAttempts = chapter.review?.attempts ?? 0;
        const maxAttempts = config.maxReviewAttempts;

        const finish = async (
          result: GateResult,
          semantic: ChapterReview["semantic"],
          semanticReason: string | undefined,
          storeSummary: boolean,
          truncatedLore: string[],
        ) => {
          // 计数口径：真不合格 +1；真通过归零；其余（没判成）**既不加也不清零**
          const attempts =
            result.gate === "fail" ? priorAttempts + 1 : result.gate === "pass" ? 0 : priorAttempts;
          const stop = result.gate === "fail" && maxAttempts > 0 && attempts >= maxAttempts;
          const review: ChapterReview = {
            attempts,
            verdict: result.gate,
            at: Date.now(),
            ...(result.issues.length > 0 ? { issues: result.issues } : {}),
            semantic,
          };
          const wantSummary = storeSummary && result.gate === "pass" && result.summary.length > 0;
          let recorded = true;
          let recordError: string | undefined;
          try {
            await store.updateChapterMeta(session, projectId, chapter.id, {
              review,
              ...(wantSummary ? { summary: result.summary } : {}),
            });
          } catch (error: unknown) {
            // 判定照旧返回：记账失败不该把已经拿到的结论吞掉（§2.2 的提交边界）
            recorded = false;
            recordError = error instanceof Error ? error.message : String(error);
          }
          return {
            action: "review",
            summary: resultSummary({
              chapter,
              projectTitle: project.title,
              result,
              attempts,
              maxAttempts,
              stop,
              semantic,
              chars: hard.chars,
              ...(semanticReason !== undefined ? { semanticReason } : {}),
              recorded,
              ...(recordError !== undefined ? { recordError } : {}),
              summaryStored: wantSummary && recorded,
              truncatedLore,
            }),
            details: {
              project_id: projectId,
              chapter_id: chapter.id,
              chapter_title: chapter.title,
              verdict: result.gate,
              passed: result.gate === "pass",
              semantic_check: semantic,
              ...(semanticReason !== undefined ? { semantic_check_note: semanticReason } : {}),
              attempts,
              max_attempts: maxAttempts,
              stop,
              chars: hard.chars,
              words: countWords(text),
              issues: result.issues,
              summary_stored: wantSummary && recorded,
              review_recorded: recorded,
              lore_suggestions: result.lore,
              // 只审草稿时正文还没落盘，如实说明，免得模型以为已经写进去了
              reviewed: isDraft ? "draft" : "chapter body",
              ...(prev === undefined ? {} : { prev_chapter: prev.title }),
            },
          };
        };

        // ① 本地硬门槛没过：直接判不合格，不起子 agent（省一次模型往返）
        if (!hard.passed) {
          return finish(
            { gate: "fail", issues: hard.issues, summary: "", lore: [] },
            "local-only",
            "the local checks failed, so the semantic check was not run",
            false,
            [],
          );
        }

        // ② 只要本地检查：如实报 inconclusive（本地过了 ≠ 这章合格）
        if (args.local_only === true) {
          return finish(
            { gate: "inconclusive", issues: [], summary: "", lore: [] },
            "local-only",
            "local_only was requested, so no semantic verdict was reached",
            false,
            [],
          );
        }

        // ③ 语义检查的材料：命中词条与写作简报同一口径（相关度排序 + 双上限）
        const lorebook = await store.readLorebook(session, projectId);
        const selection = rankLoreEntries(lorebook, `${prevText}\n${text}`, {
          maxEntries: config.maxInjectedLoreEntries,
          maxChars: config.maxInjectedLoreChars,
        });

        const outcome = await runStructuredSubagent({ config, subagents }, exec, {
          label: `novel_review: ${chapter.title}`,
          persona: REVIEW_PERSONA,
          outputSchema: REVIEW_OUTPUT_SCHEMA,
          prompt: buildReviewPrompt({
            projectTitle: project.title,
            chapterTitle: chapter.title,
            goal: chapter.goal?.trim() ?? "",
            outline: project.outline?.trim() ?? "",
            lore: [...selection.alwaysOn, ...selection.injected],
            prevTail: prevText,
            prevTitle: prev?.title ?? "",
            text,
          }),
        });

        const truncatedLore = selection.truncated.map((entry) => entry.name || entry.keys);
        if (outcome.kind !== "ok") {
          // 基础设施故障 = 没判成，不是不合格：不加计数也不清零
          return finish(
            { gate: "inconclusive", issues: [], summary: "", lore: [] },
            outcome.kind === "unavailable" ? "unavailable" : "failed",
            outcome.reason,
            false,
            truncatedLore,
          );
        }

        const verdict = normalizeReviewVerdict(outcome.structured);
        if (verdict === null) {
          return finish(
            { gate: "inconclusive", issues: [], summary: "", lore: [] },
            "failed",
            `the sub-agent did not report a usable verdict (raw: ${preview(outcome.text, 160)})`,
            false,
            truncatedLore,
          );
        }

        return finish(
          {
            gate: verdict.verdict,
            issues: verdict.issues,
            summary: verdict.summary,
            lore: verdict.lore,
          },
          "ok",
          undefined,
          args.write_summary !== false,
          truncatedLore,
        );
      },
    }),
  );
}
