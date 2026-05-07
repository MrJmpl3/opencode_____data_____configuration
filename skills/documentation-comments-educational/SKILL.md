---
name: documentation-comments-educational
description: 'Create educational comments in code files so they become effective learning resources. If no file is provided, request one and offer close matches.'
---

# Educational Comments

This skill turns code files into learning resources by adding comments that explain intent, behavior, trade-offs, and risks without changing runtime behavior.

## When to Use

- A file needs educational comments for onboarding, review, or maintenance.
- The user wants code explained for a specific audience or learning level.
- The user provides a short natural-language note such as "make this beginner friendly" or "focus on error handling".
- Do not use it for files that cannot be safely commented without risking syntax or behavior.

## Input Handling

- Require at least one target file.
- If no file is provided, ask for one and offer a numbered list of close matches when possible.
- If multiple files are provided, process them sequentially, one file at a time.
- Treat any user note as a priority signal, not as a rigid configuration system.
- If the note is ambiguous or contains obvious typos, infer the intended meaning from context.
- If the file is already commented, refine the existing comments instead of adding noise.

## Core Principles

1. Preserve behavior, syntax, encoding, indentation, and line endings.
2. Explain why the code exists and how it works, not just what it does.
3. Match the depth of explanation to the reader implied by the code and the user note.
4. Prefer clarity and narrative flow over isolated labels or repetitive paraphrases.
5. Use the safest native comment syntax for the language.
6. Never suggest code changes unless the user explicitly asks for improvements.
7. If a language or file type cannot be safely commented, stop and ask for guidance.

## Commenting Style

- Write comments as a coherent explanation that reads top to bottom.
- Start each comment block or section with a `# --- header (max ~60 chars) ---` that signals the topic.
- Follow with how it works and why it was written this way.
- Optionally end with a consequence, edge case, or tiny example.
- Keep simple sections brief and non-obvious sections more detailed.
- Reinforce a concept only when it improves comprehension.
- Use a professional, instructional tone that stays concise.
- Avoid decorative ASCII borders (`====`, `****`, `----`, `____`) — they add visual noise without information.
- Use blank comment lines only when they improve readability.
- Keep comment clusters short; avoid more than 3 consecutive comment lines before code.
- Keep the total number of educational comment lines under 400; for very large files, cap at 300.

## Structural Guidance

- Label major logical groups with `# --- short header (max ~60 chars) ---` when they improve navigation.
- Keep section labels short, uniform, and purely navigational.
- For files longer than 30 lines of code, add a brief file summary near the top after any encoding declaration or shebang.
- Add a compact metadata header near the top only when the user asks for traceability or the file is being documented as part of a larger review.
- If a code block hides a surprising side effect, runtime-only failure, hidden ordering dependency, or deprecated API usage, place a `[!]` warning comment immediately before it.
- Use `[!]` only for real behavioral risks, never for style or performance opinions.
- If the user asks for numbered notes, prefix new comments with `Note <number>` and reset numbering for each file.

## Behavior With User Notes

- "make this beginner friendly" means explain foundational ideas more explicitly.
- "keep it concise" means reduce repetition and prefer section labels over dense prose.
- "focus on error handling" means spend more detail on failure paths, guards, and warnings.
- "explain architectural choices" means emphasize design trade-offs and boundaries.
- Any similar short note should be treated as guidance, not as a parameter list.

## Validation

- Confirm formatting, encoding, indentation, and syntax remain intact.
- Confirm comments add value at the implied reader level.
- Confirm warnings are used only where the behavior could surprise the reader.
- Confirm section labels, summaries, and optional headers are present only when helpful.
- Confirm existing comments are refined rather than blindly expanded.
