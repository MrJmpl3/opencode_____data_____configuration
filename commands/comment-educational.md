---
description: Add or refine educational comments in code files
model: 'openai/gpt-5.4-mini'
---

Objective: add or refine educational comments in the smallest safe scope using `documentation-comments-educational` as the source of truth.

Arguments:

- `$ARGUMENTS` can be a file path, a directory path, or a natural-language request.
- Treat clear directives in `$ARGUMENTS` as guidance for reader level, focus areas, and tone, not as a rigid parameter map.
- If the request is ambiguous, ask one brief clarifying question before editing.

Steps:

1. If `$ARGUMENTS` is empty, stop immediately and report:
   "Please provide a target file or directory path. Example: `/comment-educational path/to/file`"
2. Resolve whether `$ARGUMENTS` points to a file, a directory, or a request.
3. Load and follow the `documentation-comments-educational` skill before changing anything.
4. If the target is a request, infer the most likely file or directory from repo context. If more than one target is plausible, ask one brief clarifying question.
5. If the target is a file, read it completely. If it is a directory, inspect it and select only the smallest sensible subset of files that clearly benefit from educational comments.
6. Skip generated files, vendored code, dependencies, build artifacts, lockfiles, binaries, and files that cannot be safely commented.
7. Plan comments using the skill rules:
   - preserve behavior, syntax, formatting, indentation, and line endings
   - explain intent, behavior, trade-offs, and risks
   - prefer why over obvious mechanics
   - refine existing comments instead of stacking duplicates
   - use native comment syntax for the file type
   - add section labels only when they improve navigation
   - use `# --- header (max ~60 chars) ---` as section label format
   - avoid ASCII art decorations (`====`, `****`, `----`, `____`)
   - add a brief file summary near the top for files longer than 30 lines of code
   - use `[!]` only for real behavioral risks
   - keep comment clusters short and low-noise
   - write bodies as natural prose, focusing on why over mechanics
8. Edit only the smallest useful scope. Do not rewrite whole files just to add comments.
9. Re-read every edited file and verify the comments are consistent, concise, technically correct, and syntax-safe.
10. Return a short summary of the edited files, the sections commented or refined, and any intentionally skipped files if the target was a directory.

Constraints:

- Do not change runtime behavior.
- Do not rename symbols unless explicitly requested.
- Do not add metadata headers unless the user asks for traceability.
- Do not add placeholder comments or TODOs.
- Do not rewrite the whole file just to add comments.
- Do not force the same comment density across languages or file types.
- Do not touch generated or third-party files just to make the directory look uniformly commented.
- Stop and ask for guidance if a file type cannot be safely commented.

## Desired comment style examples

- "Este bloque concentra la configuracion comun para que los cambios del entorno queden fuera de la base."
- "Aqui no alcanza con ver el nombre de la funcion; el comentario aclara por que se hace asi y que problema evita."
- "En este punto conviene priorizar legibilidad, porque el comportamiento depende mas del orden que de la complejidad del codigo."
