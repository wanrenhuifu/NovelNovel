---
name: novel-writing
description: Write, continue, revise, outline or export a novel that lives in a NovelNovel project (the novel_* tools). Use when the user asks for prose, a new chapter, a continuation of the story, a rewrite or polish of existing text, a chapter/whole-book summary or outline, or asks what the story's settings, characters, world book and writing style currently are.
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
5. **Keep continuity bookkeeping.** When the prose establishes a new fact, place,
   artefact or relationship the later chapters must respect, add it with
   `novel_lorebook action=add name="…" keys="…" content="…"`. Tag chapters as the
   story evolves (`novel_chapter action=tag add_tags=["伏笔"]`), and rename or reorder
   chapters to keep the outline readable.

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

## Continuity checklist before landing prose

- Does the new text contradict a lorebook entry, a character card or an earlier chapter?
- Are the participating character cards still the right ones (`novel_character
  action=list`, `action=enable/disable`)? A card that should not speak in this scene
  should not be injecting its personality into the brief either.
- Is the chapter the right length for its role in the outline? If the user asked for a
  specific length or a cliffhanger, satisfy it before appending.
