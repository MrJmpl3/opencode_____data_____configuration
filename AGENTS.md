# AGENTS.md

OpenCode workspace config repo at `~/.config/opencode`.

## What this repo controls

- `opencode.json` is the main runtime source of truth: it disables built-in `general` and `explore`, enables MCPs, configures LSPs, and loads the `oh-my-opencode-slim` plugin.
- `oh-my-opencode-slim.json` defines the active agent preset. Current preset is `openai`; `oracle`/`orchestrator` use `openai/gpt-5.4`, the other local specialist roles use `openai/gpt-5.4-mini`.
- `tui.json` controls sidebar plugins. The local plugins are `plugins/limits`, `plugins/quota`, and `plugins/cache`, all mounted via plugin tuples with `compact: true`.

## Repo boundaries that matter

- `plugins/limits/index.tsx` shows current model + limits.
- `plugins/cache/index.tsx` shows cache/token stats from session messages.
- `plugins/quota/index.tsx` is the most stateful local plugin; it supports `compact` plus `visibleProviders` and fetches provider data via `providers.ts`.
- `commands/*.md` are executable command specs. Right now `/commit-staged` and `/comment-educational` both pin `model: 'openai/gpt-5.4-mini'` in frontmatter.
- `skills/` is tracked in git. Custom bundled skills currently include `clonedeps`, `codemap`, and `simplify` alongside many other local skills.

## Verification commands actually useful here

- There are no root npm scripts, no CI workflows, and no repo-local hooks. Do not guess `npm test`, `pnpm lint`, etc.
- Focused TS/TSX verification is done ad hoc with explicit files, for example:
  - `pnpm exec tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --jsx preserve --skipLibCheck plugins/limits/index.tsx plugins/cache/index.tsx plugins/quota/index.tsx plugins/quota/providers.ts`
- Validate `tui.json` or other JSON files with:
  - `python -m json.tool tui.json`
- `opencode.json` configures an `oxlint` LSP, but that does **not** guarantee a working manual `pnpm exec oxlint` command in this repo. Prefer TypeScript checks unless you verify `oxlint` is available first.

## Git / working tree gotchas

- `.gitignore` ignores `node_modules`, `package.json`, `.gitignore`, and `tasks/`.
- Because `package.json` is gitignored, edits to it will not appear in `git status` unless you force-add them.
- Check staged vs unstaged carefully before commits; this repo often carries local config churn.

## Local workflow conventions worth preserving

- For commit messages, `/commit-staged` is the source of truth: `<emoji> <type>(<scope>): <description>` with a real Unicode emoji and a Spanish lowercase description.
- For quota UI changes, keep new provider fetchers in `plugins/quota/providers.ts`; do not move polling/timer logic out of `plugins/quota/refresh-scheduler.ts`.
- If you change sidebar presentation, preserve the plugin options already wired in `tui.json` (`compact` for all three local plugins, `visibleProviders` for quota).
