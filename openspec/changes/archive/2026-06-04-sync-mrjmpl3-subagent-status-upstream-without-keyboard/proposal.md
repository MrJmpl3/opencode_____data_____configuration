# Proposal: Sync mrjmpl3 subagent status upstream without keyboard

## Intent

Bring proven upstream fixes and core improvements into the local fork without reintroducing keyboard
or focus UX. The plugin should gain better reconciliation, rendering, and token/context accuracy
while staying mouse-only and package-local.

## Scope

### In Scope

- Port upstream non-keyboard improvements for event parsing, stale-running cleanup, duplicate
  collapse, token/context hydration, and rendering.
- Preserve the current package identity, entrypoint shape, and mouse-click navigation.
- Plan spec coverage for reconcile, state, render, and log-driven hydration behavior changed by the
  sync.

### Out of Scope

- Importing `src/tui-commands.ts`, `src/tui-focus.ts`, `useKeyboard`, hotkeys, or focus-restoration
  behavior.
- Adopting the upstream publish/build/release structure or doing unrelated UI redesign.

## Capabilities

### New Capabilities

- `mrjmpl3-subagent-status`: Mouse-only subagent status plugin that MUST reconcile child sessions
  accurately, hydrate token/context data, collapse duplicate or stale rows safely, and render
  clickable status rows without keyboard controls.

### Modified Capabilities

- None.

## Approach

Use a selective non-keyboard port. Adapt upstream `events`, `reconcile`, `state`, `render`, and
`logs` logic inside `tui-plugins/mrjmpl3-subagent-status`, but keep the current local TUI shell and
package boundaries. Exclude keyboard/focus modules completely and retain local identity unless a
targeted bug fix requires a small compatibility change.

## Affected Areas

| Area                                                                                                  | Impact   | Description                                                           |
| ----------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------- |
| `tui-plugins/mrjmpl3-subagent-status/src/tui.tsx`                                                     | Modified | Keep mouse-only shell while adopting non-keyboard render/state wiring |
| `tui-plugins/mrjmpl3-subagent-status/src/events.ts`                                                   | Modified | Port richer upstream event parsing                                    |
| `tui-plugins/mrjmpl3-subagent-status/src/reconcile.ts`, `src/state.ts`, `src/logs.ts`, `src/types.ts` | Modified | Port sync, dedup, stale, hydration, and state-shape improvements      |
| `tui-plugins/mrjmpl3-subagent-status/src/*.test.ts`                                                   | Modified | Cover upstream-derived edge cases without keyboard scenarios          |

## Risks

| Risk                                                    | Likelihood | Mitigation                                                          |
| ------------------------------------------------------- | ---------- | ------------------------------------------------------------------- |
| Keyboard behavior leaks back in                         | Medium     | Explicitly exclude keyboard/focus files in specs and implementation |
| Partial port regresses counts, tokens, or stale pruning | Medium     | Define behavior first in specs and port module-by-module            |
| Full parity work exceeds 400-line review budget         | High       | Split follow-up tasks into reviewable slices                        |

## Rollback Plan

Revert the sync follow-up changes inside `tui-plugins/mrjmpl3-subagent-status/` and restore the
pre-sync local reconcile/state/render flow if upstream adaptations regress behavior or introduce
keyboard-related code.

## Dependencies

- Upstream reference: `Joaquinvesapa/sub-agent-statusline`
  `main@9f45cd3f7cbd3240a75dfea7239b79edce40b5f3` (`v0.8.0`)

## Success Criteria

- [ ] The local plugin gains the selected upstream non-keyboard behaviors while remaining
      mouse-only.
- [ ] No proposal, spec, or implementation scope includes keyboard, focus, or command-palette
      modules.
- [ ] The resulting implementation plan can be split to respect the 400-line review budget.
