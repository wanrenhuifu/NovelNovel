---
name: novel-plan
description: Plan a whole book before any prose exists — the entry point for "write me a novel" in a NovelNovel project. Settle the premise, produce the three-level outline (project.json outline = whole-book synopsis, outline.md = detailed volume/chapter plan, one goal per chapter), then STOP and hand the outline to the author for review. Load it when starting a long project or when the user wants to plan/outline first. 中文触发：先规划、写大纲、定大纲、开新书、写长篇、排章节、大纲确认。
whenToUse: 开一本新书 / 先大纲后正文 / 排章节与伏笔 / 长篇规划，或用户说"先规划再写".
---

# Plan the book, then stop

This is the planning half of a two-phase workflow: **outline first, prose second**.
It ends with a deliverable — the outline — and an explicit pause, not with text.

## 1. Settle the premise

`novel_project action=list` then `action=show`; if the workspace has no project,
`novel_project action=create title="…" synopsis="…"`. Take what the author already
gave you. Ask only for what you genuinely cannot invent — genre and length, whose
story it is, how it ends — and keep it to a few questions.

## 2. Produce the outline in three levels

- **Level 1 — the whole-book synopsis**, 300–800 characters: who wants what, what
  stands in the way, what the ending costs. Store it with
  `novel_project action=update outline="…"` and read it back with `action=show`.
  This level is **pushed into every brief**: once it is set, the system prompt of
  each `novel_context` call carries it verbatim as a `## 全书大纲` block, preset or
  no preset. So keep it to the throughline — anything longer belongs in level 2.
- **Level 2 — the detailed outline, `outline.md`**, a plain file inside the project
  directory (`.novelnovel/projects/<projectId>/outline.md`) written with the ordinary
  `write` tool. There is deliberately no `novel_*` tool for it: it is far too long to
  inject into every brief, so you read the slice you need with the `read` tool.
  Put volume/act structure, chapter beats, the plant-and-payoff ledger, and the
  relationship/timeline changes in it. One heading per volume, chapter lines under it.
- **Level 3 — one goal per chapter**, a single sentence saying what that chapter
  advances. `novel_chapter action=create title="…" goal="…"` when you create the
  chapter, or `novel_chapter action=meta chapter=<ref> goal="…"` afterwards. It is
  injected too, but on a different path: `novel_context` puts it at the head of the
  instruction block as `本章目标：…`. **Level 2 is the only level that never reaches
  the brief** — re-read `outline.md` yourself whenever a chapter touches the
  throughline.

Use `novel-outline` for the craft of structure itself (throughlines, escalation
ladders, 伏笔回收); this skill is the workflow around it.

## 3. Stop and hand it over

**Do not write prose in this phase.** Report the outline — premise, structure,
chapter list with goals — and wait for the author.

Why stopping here is the point: changing an outline costs one message. Changing
chapters that are already written costs rewriting every chapter it touched, plus
everything the brief already told you to keep consistent (lorebook entries,
character cards, earlier prose). The author is the only one who can judge whether
the premise is worth a book, so spend their attention before the expensive part,
not after it.

When they approve — or once they say "go" — continue with the writing loop below.

## The writing loop (unchanged after approval)

1. `novel_context chapter=<ref>` — the author's brief: setting, style, keyword-matched
   lorebook entries, participating character cards, the tail of the previous chapters,
   the tail of this chapter, this chapter's goal as the task, and how many chapters
   still have no text.
2. Write the prose in the project's language. Only the story text — no headings,
   notes, summaries or meta commentary inside a chapter.
3. Check it: `novel_review chapter=<ref> text=<the draft>` — reviewing the draft before
   it is landed is the preferred order. `fail` sends you back to step 2 with concrete
   issues; `STOP` means report to the author instead of rewriting again; `inconclusive`
   is not a pass.
4. Land it: `novel_chapter action=append chapter=<ref> text="…"`.
5. Bookkeeping: new facts the later chapters must respect go in with
   `novel_lorebook action=add name="…" keys="…" content="…"`; tag or rename chapters
   as the story moves (`novel_chapter action=tag`, `action=rename`).

One chapter at a time. After each landing, the next chapter's goal from the outline
tells you what to brief for — and the book is done when `novel_context` /
`novel_project action=show` reports that every chapter has text.

If the user asked for the whole book in this turn, put the task under a goal
(`create_goal` with the objective "write all N chapters, each passing `novel_review`")
so the loop continues across rounds. The goal can only be created in a turn that came
from the user, so do it now rather than later.
