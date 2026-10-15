---
name: novel-quick
description: Skip the book-level outline and go straight into the writing loop — the entry point for short pieces, single scenes, episodic or slice-of-life works, and any "just keep writing" request in a NovelNovel project. Use when the user wants prose now rather than a plan, or asks for a chapter/scene continuation without an outline. 中文触发：直接写、不用大纲、立刻写、写短篇、单元剧、随手写一章、继续写。
whenToUse: 短篇 / 单元剧 / 没有贯穿线索的作品 / 用户说"直接写、别规划" / 续写既有章节.
---

# Write now, plan later

The other entry point is `novel-plan` (outline first, then stop for review). This one
deliberately starts the prose loop on the first round.

## When this is the right entry

- The work has **no throughline that must be closed**: episodic chapters, slice of
  life, a single scene, a vignette, a writing exercise.
- It is a short piece, and the author does not want to spend a round on planning.
- The author said so — "直接写", "别规划了", "just write".

The test is **not length**, it is whether threads must converge later. A 20-chapter
serial with a mystery to resolve needs the plan; a 3-chapter short with no payoff owed
does not. When in doubt, ask — one question is cheaper than a wrong mode.

## Set up only what the scene needs

Locate the project (`novel_project action=list` / `action=show`, `action=create` if the
workspace has none). Then:

- `novel_chapter action=create title="…" goal="…"` — the goal is optional here, but one
  sentence is cheap and makes the brief carry `本章目标：…` instead of nothing.
- `novel_character action=import` / `action=enable` for whoever speaks in this piece.
- `novel_lorebook action=add` for the settings this scene actually uses. Entries with
  keywords are injected only when those keywords appear; entries without keywords are
  injected every round, so use them sparingly.

Skip: the whole-book outline (`project.outline`), the detailed `outline.md`, and the
chapter-by-chapter plan. None of them is ever required — a project without them works
exactly like a planned one. If a throughline does show up later, set `project.outline`
deliberately: it is the one outline level that is **pushed**, so every later
`novel_context` brief carries it as a `## 全书大纲` block, preset or no preset.
`outline.md` is never injected — read it yourself when you need it.

## The loop

1. `novel_context chapter=<ref>` — the brief: the whole-book outline (when
   `project.outline` is set), setting and style, keyword-matched
   lorebook entries, participating character cards, the active preset, the tail of the
   previous chapters and of this chapter, plus the instruction block for this round.
   Pass `instruction="…"` for anything other than a plain continuation.
2. Write the prose in the project's language. Only story text — no headings, notes or
   meta commentary inside a chapter.
3. Land it: `novel_chapter action=append chapter=<ref> text="…"` (or `action=write` to
   replace a chapter wholesale).
4. Record the facts the next round must respect: `novel_lorebook action=add …` for
   places, rules and relationships, `novel_chapter action=meta goal="…"` for what the
   chapter you just wrote was for.
5. Next chapter: `novel_chapter action=create …`, then back to step 1.

## If a throughline shows up after all

It often does by chapter three. You can build the outline retroactively: read what is
already written (`novel_chapter action=list`, `action=read`), write `outline.md`, set
`novel_project action=update outline="…"`, and fill in the goals for the chapters that
already exist with `action=meta`. The prose already landed is not wasted — switch to
`novel-plan` for the remaining chapters rather than continuing blind.

For the craft itself (`novel-prose`, `novel-dialogue`, `novel-scene`) load the matching
skill; none of them is required to start.
