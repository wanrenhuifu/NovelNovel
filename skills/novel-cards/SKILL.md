---
name: novel-cards
description: Import, inspect, adjust or re-export SillyTavern character cards and writing presets in a NovelNovel project (novel_character, novel_lorebook, novel_preset). Use when the user brings a .png/.json character card or preset file, asks how the card's world book or macros were handled, wants a card excluded from the writing brief, or wants a card handed back to SillyTavern.
whenToUse: Character card files (PNG/JSON, V1/V2/V3), SillyTavern world books, story_string presets, {{char}}/{{user}} macros, or "把这张卡导出/导入".
---

# SillyTavern cards and presets in NovelNovel

## Character cards

- `novel_character action=import path=<card.png|card.json>` reads the file from disk.
  PNG/APNG/WebP/JPEG cards carry their data in a `tEXt` chunk (`ccv3` wins over
  `chara`); JSON cards may embed an avatar as a data URL. V1/V2/V3 specs are all accepted.
- The original card JSON is preserved verbatim in `<id>.json` (`rawData`), and the
  avatar is stored next to it as `<id>.png`, so `action=export` can hand the card back
  to SillyTavern as a PNG with both `chara` and `ccv3` chunks written.
- A card's own world book (`character_book`) is **merged into the project lorebook at
  import time**, and `{{char}}` / `<BOT>` in those entries are resolved to that card's
  name right then. Once merged, the entries are project-level facts: removing the card
  later does not remove them (`novel_lorebook action=remove` does).
- `active` decides participation: only active cards contribute
  description / personality / scenario to the brief that `novel_context` assembles.
  Turn a card off with `action=disable` when it should stay in the library without
  steering this chapter's prose, rather than deleting it.

## Lorebook semantics

- `keys` is a comma-separated list (full-width `，` also works). An entry is injected
  only when one of its keywords appears in the assembled context (the excerpted
  previous chapters plus the tail of the current chapter).
- An entry **without** keys is always injected — use that for core world rules,
  narrative voice, or a glossary the model must never violate.
- Keep entries focused: one fact per entry with precise keywords beats one giant entry,
  because injection is keyword-scoped. Name entries the way you would refer to them.

## Writing presets

- `novel_preset action=import path=<preset.json>` accepts the four bare SillyTavern
  preset shapes (sysprompt / context / instruct / reasoning) and the combined envelope.
  `content` becomes the system prompt (replacing the built-in opening),
  `story_string` becomes the setting-block template (replacing the whole block, at
  which point the lorebook is exposed to the template as the `wiBefore` variable).
- `story_string` supports the subset `{{#if var}}…{{else}}…{{/if}}`, `{{trim}}` and
  `{{var}}` with the variables `title`, `synopsis`, `worldbuilding`, `system`
  (the project's writing requirements), `description`, `personality`, `scenario`,
  `wiBefore`, `wiAfter`, `persona`, `anchorBefore`, `anchorAfter`.
- `instruct` presets only describe dialogue turn formatting, which the harness's own
  message structure owns — they are archived and never applied;
  `novel_preset action=activate` refuses them.
- Macros `{{char}}` (first participating character) and `{{user}}` (the protagonist,
  `主角` by default) are expanded when the brief is assembled.

## Reporting back

When you import or change a card, tell the user what actually changed: how many world
book entries were merged (and how many duplicates were skipped), whether the avatar came
along, and whether the card participates in the brief. When a preset import drops part of
the file (an `instruct` or `reasoning` section), say so explicitly instead of implying
the whole file was applied.
