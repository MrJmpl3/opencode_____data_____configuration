---
name: mrjmpl3-add-educational-comments
description:
  'Use when adding, writing, editing, auditing, translating, restructuring, or removing code
  comments. Act as both comment reviewer and comment writer with professional technical Spanish by
  default.'
---

# Add Educational Comments

Use this skill whenever the task touches code comments in any meaningful way: adding, writing,
editing, auditing, translating, restructuring, or removing them. The goal is not to "sprinkle
explanations" but to act in both modes when needed: review existing comments with editorial rigor,
and write new comments only where they materially improve understanding.

## Activation Contract

- This skill is the mandatory gate before touching code comments.
- If no file or code region is provided, ask for it first.
- Treat comment work as editorial work over a coherent block, not as isolated line tweaks.
- Operate as both a **comment reviewer** and a **comment writer**; review first, then write only
  what the code genuinely needs.

## Hard Rules

### Language and voice

- Default comment language is Spanish.
- Use another language only when the user explicitly asks for that artifact, or when the surrounding
  codebase already uses another comment language and consistency matters more.
- Write in natural, professional technical Spanish. Prefer phrasing real developers would write
  during maintenance.
- Keep established technical loanwords when they are the clearest term, such as `cache`, `deadlock`,
  `worker`, `shim`, `boilerplate`, `pipeline`, or `seam`.
- Avoid awkward calques, forced translations, and Spanglish constructions.

### What comments should do

- Comment intent, constraints, hidden tradeoffs, invariants, tricky framework behavior, and
  non-obvious syntax.
- Do not comment code that already explains itself through names and structure.
- Keep comments lean and high-signal.
- Prefer short comments by default: one precise sentence beats a mini-paragraph.
- Expand only when the concept genuinely needs more context, such as architecture rationale, subtle
  language behavior, or easy-to-break edge cases.
- Every new comment must clarify something a future maintainer would not reliably infer from the
  code alone.

### Editing strategy

- Re-read the full affected region before editing comments so the final result is coherent as a
  whole.
- You may rewrite, merge, reorder, or remove existing comments when they are stale, redundant,
  noisy, misleading, or weaker than the replacement.
- When improving a weak comment, replace it with a complete better version instead of stacking
  patches on top.
- If a comment does not earn its place, delete it or avoid adding it.

### Reviewer and writer stance

- As reviewer: audit whether each comment is accurate, necessary, concise, and worth the visual
  space it consumes.
- As writer: add new comments only when the code would otherwise hide intent, a constraint, a
  tradeoff, or a non-obvious behavior.
- Default sequence: review existing comments first, then decide whether the best outcome is keep,
  rewrite, remove, or add.
- Default priority: **remove > rewrite > add**.
- Do not add a new comment if deleting or rewriting an existing one already solves the problem more
  cleanly.

### Safety and formatting

- Preserve behavior, syntax, encoding, line endings, and indentation.
- Respect the host language comment syntax and surrounding style.
- Do not introduce decorative noise, emojis, or formatting gimmicks.

## Decision Gates

| Situation                                                            | Action                                                                        |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| No file or snippet provided                                          | Ask for the target file or code region before proceeding                      |
| The region has no comments yet                                       | Decide whether new comments are truly needed before adding any                |
| A weak comment can simply disappear without losing important context | Remove it instead of replacing it                                             |
| Existing comments are mostly good but uneven                         | Normalize tone and remove only the weakest comments                           |
| Existing comments are verbose or obvious                             | Compress or delete them, then keep only the comments that carry intent        |
| A long comment can be reduced without losing meaning                 | Rewrite it as the shortest version that still preserves the key insight       |
| Comments and code use different languages                            | Prefer repo consistency unless the user explicitly requested another language |
| Unsure whether a comment adds value                                  | Delete it or rewrite it around intent, constraint, or tradeoff                |

## Workflow

1. **Confirm scope** - Identify the file or exact region to review.
2. **Read the block** - Inspect the surrounding code, not just the commented lines.
3. **Review first** - Separate useful comments from obvious, stale, misleading, noisy, or missing
   ones.
4. **Choose the right action** - For each spot, decide with this bias: remove first, rewrite second,
   add last.
5. **Write with intent** - Add or rewrite only the comments that explain why the code exists or what
   constraint it protects.
6. **Trim aggressively** - Remove filler and repetition so the signal-to-noise ratio improves.
7. **Validate safety** - Ensure only comments changed unless the user explicitly asked for code
   edits too.

## Commenting Heuristics

- Good comment targets:
  - Architectural rationale
  - Business or technical invariants
  - Framework quirks and surprising behavior
  - Edge-case handling that is easy to break later
  - Tradeoffs that justify a non-obvious implementation
- Good comment shape:
  - Usually 1 to 2 lines
  - Direct and specific
  - Written so it can be skimmed quickly during maintenance
- Bad comment targets:
  - Restating variable names
  - Narrating straightforward control flow
  - Explaining syntax every experienced maintainer already knows
  - Adding long prose where one precise sentence is enough

## Output Contract

When applying this skill:

- Leave comments more consistent, more useful, and usually fewer.
- Bias toward shorter comments unless brevity would hide the important constraint.
- Make it clear through the result that the skill reviewed the existing comments, not just wrote new
  ones.
- Prefer subtraction over addition when both outcomes preserve understanding.
- Prefer complete rewrites over incremental band-aids.
- Mention any comments you deliberately removed because they were obvious, stale, or misleading.
- Mention any new comments you added and why they were necessary.
- If no valuable educational comments should remain, say so and keep the code clean.

## Missing Input Response

If the user did not provide a file or code snippet, reply with:

`Please provide the file or code snippet whose comments you want to review.`
