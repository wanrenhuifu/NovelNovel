---
name: novel-writing
description: Write, continue, revise, outline or export a novel that lives in a NovelNovel project (the novel_* tools), and review a chapter before it is kept (novel_review). Use when the user asks for prose, a new chapter, a continuation of the story, a rewrite or polish of existing text, a chapter/whole-book summary or outline, a quality check on a chapter, or asks what the story's settings, characters, world book and writing style currently are. 中文触发：写小说、接着写、续写、写下一章、改稿、润色、大纲、导出、自检、检查这一章、这章合格吗、这本书的设定与文风。
whenToUse: Any fiction-writing request in a workspace that has a .novelnovel data directory, or when the user mentions NovelNovel, 作品/章节/角色卡/世界观词条/写作预设.
---

# Novel writing with NovelNovel

The novel is stored as ordinary files under the workspace data directory
(`.novelnovel/projects/<projectId>/`): `project.json` (metadata), `chapters/index.json`
(outline metadata) plus `chapters/<id>.md` (one Markdown file per chapter),
`characters/`, `lorebook.json`, `presets.json`, `exports/`.
The `novel_*` tools keep that structure coherent; prefer them over hand-editing files,
and read the `.md` files directly when a chapter is too long to pull through a tool.

## The loop

1. **Locate the project.** `novel_project action=list` then `action=show`
   (or `action=create title="…"` when the workspace has none). Most tools accept an
   omitted `project` and use the current one.
2. **Load the author's brief before writing.** `novel_context chapter=<ref>`
   returns the worldbuilding, the lorebook entries whose keywords hit the recent text,
   the participating character cards, the active preset, the tail of the previous
   chapters and the tail of this chapter, plus the instruction block for this round.
   Pass `instruction` for anything other than a plain continuation, e.g.
   `novel_context chapter=3 instruction="承接上文，写完林晚与祭司的对峙"`.
3. **Write the prose.** The brief's system-prompt section is authoritative for
   setting, characterisation, viewpoint, tense and style. Keep names, relationships,
   timeline and world rules consistent with it. Add no headings, notes, summaries or
   meta commentary inside chapter text — only the story.
4. **Land it.** `novel_chapter action=append chapter=<ref> text="…"` (the normal path)
   or `action=write` to replace a chapter wholesale, `action=create` for a new chapter.
5. **Check it before keeping it.** `novel_review chapter=<ref> text="…"` — pass the
   draft as `text` while it has not been landed yet; that ordering is preferred, because
   nothing reaches the disk until it passes and you never have to overwrite prose.
   Reviewing an already landed chapter is the same call without `text`.
6. **Keep continuity bookkeeping.** When the prose establishes a new fact, place,
   artefact or relationship the later chapters must respect, add it with
   `novel_lorebook action=add name="…" keys="…" content="…"`. Tag chapters as the
   story evolves (`novel_chapter action=tag add_tags=["伏笔"]`), and rename or reorder
   chapters to keep the outline readable.

## The review gate

`novel_review` runs the cheap checks locally first (length floor, stray headings or
meta lines, long passages repeated from the previous chapter) and only then a
read-only sub-agent that judges task fit and continuity. It has three verdicts:

| verdict | what to do |
|---|---|
| `pass` | keep the chapter and go on to the next one |
| `fail` | fix every issue it lists, then review again |
| `inconclusive` | the local checks passed but no semantic verdict was reached (no sub-agent in this composition, or it failed). **This is not a pass** — judge continuity and task fit yourself before moving on |

Rules that matter:

- The sub-agent only ever **judges and advises**. It cannot rewrite anything, so
  revision is always yours. Never treat its issues as instructions to paste in.
- `STOP` in the report means this chapter has already failed the configured number of
  times in a row. Do not rewrite it a fourth time: report the issues to the author and
  let them decide (change the goal, fix the outline, write it themselves).
- Fixing the text yourself does not clear the count — a chapter that passes genuinely
  resets it, and getting an `inconclusive` verdict never does.
- While drafting you can call it with `local_only=true` for a free check of length,
  format and duplication. That verdict is `inconclusive` by design.

## Writing a whole book

For anything longer than a scene, the loop above is driven by a goal so it survives
across turns: in the turn where the **user** asks for the book, call
`create_goal` (`objective`: e.g. "写完《…》的全部 24 章，每章都过 novel_review") and
then work one chapter per round. `novel_context` and `novel_project action=show`
report `progress: written/total · next unwritten: …` — use it to decide when the book
is done instead of counting chapters yourself. Entry points: `novel-plan` (outline
first, then stop for review) and `novel-quick` (straight into the loop).

## Conventions

- Chapter references accept an id, a 1-based number (`3`, `第3章`) or a title
  (exact, or unique partial match).
- Word counts count CJK characters individually and other text by whitespace — a
  useful progress signal, not an exact character count.
- Destructive actions (`action=delete` on project/chapter/character) require
  `confirm=true`; ask the user first and never pass it on your own initiative.
- `novel_export action=markdown|text|backup` writes files under the project's
  `exports/` directory; report the path instead of pasting the whole book back.
- Everything the tools return is also inspectable with the plain file tools, so a
  user edit made outside the plugin shows up in the next `action=list` / `action=read`.

## Writing craft

This skill covers the tool loop. The craft itself lives in four sibling skills —
load the one that matches the request instead of improvising:

- `novel-prose` — voice, point of view, sentence rhythm, showing versus telling,
  and the AI tells to strip out. Load it for any polish or rewrite.
- `novel-dialogue` — subtext, distinguishing speakers, tags and action beats.
- `novel-scene` — scene versus summary, goal/obstacle/turn, pacing, chapter endings.
- `novel-outline` — outlining, subplots, setup and payoff, consistency audits, and
  Chinese web-novel conventions (黄金三章, 爽点, 断章).

The brief from `novel_context` always outranks them: it carries the author's own
voice rules, and craft advice that contradicts it is wrong for this project.

## Continuity checklist before landing prose

- Does the new text contradict a lorebook entry, a character card or an earlier chapter?
- Are the participating character cards still the right ones (`novel_character
  action=list`, `action=enable/disable`)? A card that should not speak in this scene
  should not be injecting its personality into the brief either.
- Is the chapter the right length for its role in the outline? If the user asked for a
  specific length or a cliffhanger, satisfy it before appending.
