## Exploration: sync-mrjmpl3-subagent-status-upstream-without-keyboard

### Current State

The local fork is a single TUI entrypoint (`index.tsx -> src/tui.tsx`) that refreshes snapshot data from `api.client.session.children`, normalizes it in `src/reconcile.ts`, persists local state in `src/state.ts`, and backfills done-token data from local logs in `src/logs.ts`. It is already mouse-driven; a prior local decision removed keyboard command registration and focus behavior, so that constraint must stay intact.

Upstream `sub-agent-statusline` on `main` @ `9f45cd3f7cbd3240a75dfea7239b79edce40b5f3` (`v0.8.0`) is much more modular: `src/events.ts`, `src/reconcile.ts`, `src/state.ts`, `src/render.ts`, and `src/i18n.ts` hold the core logic, while `src/tui-commands.ts` and `src/tui-focus.ts` carry the keyboard layer that should not be adopted. Upstream also adds broader status parsing, stale-running reconciliation, duplicate-collapse logic, and richer token/context hydration (including SQLite-backed backfill).

Inspected files: local `package.json`, `index.tsx`, `src/events.ts`, `src/logs.ts`, `src/reconcile.ts`, `src/state.ts`, `src/tui.tsx`, `src/types.ts`, `src/*.test.ts`; upstream `package.json`, `src/index.ts`, `src/events.ts`, `src/logs.ts`, `src/reconcile.ts`, `src/render.ts`, `src/state.ts`, `src/i18n.ts`, `src/tui.tsx`, `src/tui-commands.ts`, `src/tui-focus.ts`, `src/*.test.ts`, `README.md`.

### Affected Areas

- `src/tui.tsx` — main integration point; should absorb upstream render/state/token improvements while remaining mouse-only.
- `src/events.ts`, `src/reconcile.ts`, `src/state.ts`, `src/logs.ts` — current snapshot model is simpler than upstream and misses dedup/stale-fallback/token-hydration behavior.
- `src/types.ts` — likely to expand or be folded into the richer upstream state model (`color`, `elapsedMs`, more detailed child metadata).
- `src/*.test.ts` — existing tests cover the simpler local model; upstream adds coverage for render, i18n, event parsing, and hydration/reconciliation edge cases.
- `package.json` / `package-lock.json` — only if the chosen port needs new runtime typings; do not import upstream build/release scaffolding.
- Explicit non-adoption: `src/tui-commands.ts`, `src/tui-focus.ts`, `useKeyboard`, `Alt+B`, command-palette focus registration/return-focus behavior.

### Approaches

1. **Selective non-keyboard cherry-pick** — port upstream pure helpers and state/render/token fixes into the current TUI-only plugin.
   - Pros: preserves local identity and mouse-only UX; smaller diff; avoids runtime/package restructuring.
   - Cons: manual adaptation of upstream modules/imports; duplicated logic may remain.
   - Effort: Medium

2. **Full upstream architecture port, then strip keyboard** — adopt the upstream event-driven split and remove the input layer afterward.
   - Pros: closest to upstream bug-fix parity; cleaner long-term architecture.
   - Cons: large refactor; easy to accidentally keep keyboard code; likely too large for a single 400-line review slice.
   - Effort: High

### Recommendation

Use approach 1. Port the upstream non-keyboard core first (`render`, richer state/reconcile/event parsing, token hydration, and optionally i18n), keep the current single-plugin entrypoint and mouse-click navigation, and leave the keyboard modules completely out. Preserve the local package identity and existing retention policy unless a specific upstream bug fix requires changing it.

### Risks

- Keyboard behavior can creep back in if `src/tui.tsx` is copied verbatim.
- Upstream imports are `.js`-style and its package layout is publishable; copying files blindly may not fit the local npm-only workspace.
- The state/event model is substantially richer upstream, so partial ports can regress counts, token hydration, or stale-row pruning.
- A full parity sync will almost certainly exceed the 400-line review budget and should be split.

### Ready for Proposal

Yes — but scope it as a non-keyboard upstream-sync slice. If the proposal includes the command/focus layer or a full architecture rewrite, split it first.
