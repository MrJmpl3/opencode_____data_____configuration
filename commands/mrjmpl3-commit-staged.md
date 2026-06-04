---
description: ✅ Valida los cambios staged y crea un commit con mensaje convencional
---

Objective: validate staged changes, run a quick diff check, generate a commit message and commit.

Steps:

1. Run `git diff --cached --name-only` to list staged files.
2. If output is empty (no staged files), stop immediately and report:
   "No staged files found. Stage files with `git add` first."
3. Run `git diff --cached --check` to catch whitespace errors and conflict markers.
4. If `git diff --cached --check` reports any problem, stop immediately and report the exact output. Do not commit.
5. Run `git diff --cached` to read the full diff.
6. Generate commit message following these rules:
   - Format: `<emoji> <type>(<scope>): <description>`
   - Gitmoji: MUST use real Unicode emoji (e.g. ✨), NEVER shortcode (e.g. :sparkles: is forbidden)
   - Language: description in Spanish, entirely lowercase, max 100 characters
   - Content: prefer the "why" when it is supported by the diff or nearby context; otherwise use a conservative description of the change without inventing motivation
   - Scope: use the smallest meaningful scope from the staged files; if the change spans multiple areas, use the app/package/service name
   - Use the generated message directly in `git commit -m "<message>"`.
7. Run `git commit -m "<message>"`.
8. If `git commit` fails, report the failure output and stop.
9. Run `git status` to confirm the commit was successful.
10. Report whether the commit succeeded and include the exact commit message used.

Do not add unstaged files. Do not amend previous commits.

## Valid commit message examples

✨ feat(factura): agregar validacion de montos negativos
🐛 fix(tenant): corregir aislamiento de cache en jobs
♻️ refactor(auth): extraer logica de tokens a servicio dedicado
