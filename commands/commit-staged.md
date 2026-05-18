---
description: Commit staged changes with conventional message
model: 'openai/gpt-5.4-mini'
---

Objective: validate staged changes, run a quick diff check, generate a commit message and commit.

Steps:

1. Run `git diff --cached --name-only` to list staged files.
2. If output is empty (no staged files), stop immediately and report:
   "No staged files found. Stage files with `git add` first."
3. Run `git diff --cached --check` to catch whitespace errors and conflict markers.
4. Run `git diff --cached` to read the full diff.
5. Generate commit message following these rules:
   - Format: `<emoji> <type>(<scope>): <description>`
   - Gitmoji: MUST use real Unicode emoji (e.g. ✨), NEVER shortcode (e.g. :sparkles: is forbidden)
   - Language: description in Spanish, entirely lowercase, max 100 characters
   - Content: strictly focus on the "why" of the change, not just the "what"
   - Scope: use the smallest meaningful scope from the staged files; if the change spans multiple areas, use the app/package/service name
   - Output: return ONLY the plain text commit message. No explanations, no backticks, no Markdown.
6. Run `git commit -m "<message>"`.
7. Run `git status` to confirm the commit was successful.

Do not add unstaged files. Do not amend previous commits.

## Valid commit message examples

✨ feat(factura): agregar validacion de montos negativos
🐛 fix(tenant): corregir aislamiento de cache en jobs
♻️ refactor(auth): extraer logica de tokens a servicio dedicado
