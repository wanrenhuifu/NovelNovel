---
name: novel-prose
description: Diagnose or revise the prose of a NovelNovel chapter — sentence rhythm, narrative distance, point-of-view consistency, showing versus telling, and removing AI tells (stacked similes, filler intensifiers, parallel triads, labelled emotions). Use for a polish request, for "this reads like AI", or for text that feels flat, overwrought or generic.
whenToUse: Polishing, rewriting, de-AI-ing or voice-matching existing prose in a NovelNovel project — 润色 / 改写 / 去 AI 味 / 文风不一致 / 「读起来像 AI」/「太平」/「太满」.
---

# Prose and narrative voice

This skill is method, not policy. The brief that `novel_context` assembles — the
project's writing requirements, the active preset, the participating character
cards — is authoritative for voice. Where this file and the brief disagree, the
brief wins. Read the brief first, then apply the checks below.

## Narrative distance

Decide, per scene, how close the camera sits to the viewpoint character, and hold it.

- **Close** — the narrator knows only what the character perceives and thinks.
  Thoughts need no attribution. The default for emotional scenes.
- **Middle** — perception plus interpretation, without naming private thoughts.
- **Far** — summary and report. Good for covering time, useless for tension.

The commonest failure is drift: a scene opens close and slides into report whenever
the plot needs explaining. If a sentence states something the viewpoint character
cannot know in this moment, either move the camera or cut the sentence.

## Point of view

Whatever the brief fixes — first or third person, past or present, single or multi —
hold person, tense and head-hopping discipline for the whole chapter.

- One head per scene. Another character's interiority may be *inferred from
  behaviour*, never read directly.
- Knowledge is bounded: a character cannot react to a fact they have not learned on
  the page. When a scene only works because someone knows too much, the fix is
  upstream in the outline, not a rewrite of the sentence.
- Keep the tense of recollection distinct from the tense of the scene.

## Sentence rhythm

Rhythm comes from *variation*, not from any particular length.

- A run of same-length, same-shape sentences reads as machine output even when every
  sentence is fine. Break it.
- Long sentences carry reflection, elaboration and slowed time. Short ones carry
  impact, decision and the turn. Put a short sentence where the scene turns.
- Prefer the shortest sentence in the paragraph as its first.
- Vary syntax as well: subject-first every time is a tell. Front a subordinate
  clause, an adverbial or an object when it earns emphasis.

## Showing and telling

Both are legitimate. The failure is doing both, in that order, for the same beat.

- Prefer the specific physical or sensory detail over the abstract label. A reader
  who infers anger from a held breath feels it; a reader told "他很愤怒" merely
  files it.
- Do not show and then label — "他的手在抖，说明他很紧张". Say it once.
- Naming an emotion is fine when the character is misreading themselves, or when the
  gap between the label and the behaviour is the point.

## Removing machine tells

Check every passage for these. They are most of the difference between a chapter
that reads as written and one that reads as generated.

- **Filler intensifiers** — 仿佛, 似乎, 不禁, 不由得, 深深地, 静静地, 微微, 缓缓,
  淡淡地. Strike them; the sentence almost always improves.
- **Stacked similes** — two or three comparatives on one image ("仿佛…，又似…").
  Keep the strongest, delete the rest.
- **Parallel triads** — every observation arriving as three matched clauses. Once
  per scene it is a device; every paragraph it is a tic.
- **Adjective stacking** — three modifiers before one noun. Keep one, the most
  concrete.
- **Symmetrical antithesis** — 不是…而是… as the default move for every idea.
- **Summary closers** — a short abstract sentence at the end of a scene restating
  what just happened ("这一刻，他终于明白了…"). Cut it; the scene already said it.
- **Unearned intensity** — naming a feeling at maximum volume when the situation has
  not earned it.

## Polishing a passage

Work in this order; doing it out of order wastes the pass.

1. Read the brief; confirm the voice it asks for.
2. Fix point of view and knowledge leaks first — they change sentences.
3. Vary sentence length; put short sentences at the turns.
4. Delete the machine tells above.
5. Replace labelled emotion with the concrete detail that produced it.
6. Read the result back silently. Anything you would not say, rewrite.
7. Add no new events. A polish changes prose, not plot — if the passage needs a new
   beat, that is `novel-scene` or `novel-outline`, not this pass.
