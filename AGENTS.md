# AGENTS.md

OpenCode workspace at `~/.config/opencode`. High-signal facts for agents.

## Config files

| File | Purpose |
|------|---------|
| `opencode.json` | MCPs (context7, gh_grep, github, nuxt), LSP config, provider timeouts, plugin load |
| `oh-my-opencode-slim.json` | Agent definitions across 4 presets: `opencode-free`, `opencode-go`, `github-copilot`, `openrouter` |
| `tui.json` | Theme `opencode`, loads `oh-my-opencode-slim` + local `plugins-tui/my-quota-tui` |

- Default preset: `opencode-free` (all agents use `opencode/deepseek-v4-flash-free` variant `max`).
- `opencode.json` `plugin` field loads `oh-my-opencode-slim` — agents are defined there.
- `small_model`: `github-copilot/gpt-5-mini`.

## LSP (from `opencode.json`)

- **oxlint** via `pnpm exec oxlint` for `.js/.jsx/.mjs/.cjs/.ts/.tsx/.mts/.cts`.
- **typescript-language-server** with `NODE_OPTIONS=--max-old-space-size=8192`.

## Git state

- Single `main` branch, no remote configured, no CI, no hooks.
- Everything tracked: config, skills, plugins, commands.
- `package.json`, `bun.lock`, `.gitignore`, `node_modules/`, `tasks/` are gitignored.
- `package.json` changes will NOT appear in `git status`.

## Permissions

- `git push *` = ask
- `rm *` = ask
- `*.env` reads = deny
- Everything else = allow

## Plugins

- **Server plugin** `plugins/my-quota.js` — registers `/quota` slash command showing quotas from OpenCode Go, GitHub Copilot, and OpenRouter.
- **Shared lib** `plugins/lib/quota-providers.js` — data-fetching logic shared between server and TUI plugins.
- **TUI plugin** `plugins-tui/my-quota-tui/` — renders quota in TUI reactively (event-driven, no polling).

## Commands

- **`/commit-staged`** — `commands/commit-staged.md`. Commits staged files with `<emoji> <type>(<scope>): <description>`. Description in Spanish, lowercase, max 100 chars. Real Unicode emoji (never `:shortcode:`).
- **`/comment-educational`** — `commands/comment-educational.md`. Adds educational comments via the `documentation-comments-educational` skill.

## Skills

151 installed skills in `skills/`. Each has `SKILL.md` with frontmatter (name, description) and optional `rules/`, `references/`, `assets/` subdirectories.

## Environment

- Python 3.14.0 (`.python-version`)
- Node deps: `@opencode-ai/plugin@1.14.48`, `@opentui/core@0.2.8`, `@opentui/solid@0.2.8`
- `bun.lock` present (Bun lockfile alongside npm `package-lock.json`)

## Commit convention

Format: `<emoji> <type>(<scope>): <description>`

- Real Unicode emoji (never `:shortcode:`)
- Description in Spanish, lowercase, max 100 chars
- Scope: smallest meaningful scope from staged files

Examples:
```
✨ feat(factura): agregar validacion de montos negativos
🐛 fix(tenant): corregir aislamiento de cache en jobs
♻️ refactor(auth): extraer logica de tokens a servicio dedicado
```
