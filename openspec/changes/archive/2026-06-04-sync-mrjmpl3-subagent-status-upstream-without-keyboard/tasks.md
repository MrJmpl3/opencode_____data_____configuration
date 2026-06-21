# Tasks: Sync mrjmpl3 subagent status upstream without keyboard

## Review Workload Forecast

| Field                   | Value              |
| ----------------------- | ------------------ |
| Estimated changed lines | 550-800            |
| 400-line budget risk    | High               |
| Chained PRs recommended | Yes                |
| Suggested split         | PR 1 → PR 2 → PR 3 |
| Delivery strategy       | ask-on-risk        |
| Chain strategy          | pending            |

Decision needed before apply: Yes Chained PRs recommended: Yes Chain strategy: pending 400-line
budget risk: High

### Suggested Work Units

| Unit | Goal                            | Likely PR | Notes                                                                                                             |
| ---- | ------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------- |
| 1    | Port state/event/reconcile core | PR 1      | Base TBD after user picks chain; include RED/GREEN tests for dedup, stale terminal updates, token-safe state load |
| 2    | Add pure render helpers         | PR 2      | Depends on PR 1 state shape; include `src/render.ts` + `src/render.test.ts`                                       |
| 3    | Wire mouse-only TUI + hydration | PR 3      | Depends on PR 2; keep keyboard/focus exclusions explicit and verify navigation/count rendering                    |

## Phase 1: Foundation / Core State

- [x] 1.1 RED: add failing cases in `src/events.test.ts` for subtask/tool parsing, ambiguous event
      ignore, and target-session mapping.
- [x] 1.2 GREEN: extend `src/types.ts` and `src/events.ts` with upstream-derived child fields and
      `applySubagentEvent()` without keyboard hooks.
- [x] 1.3 RED: extend `src/state.test.ts` and `src/reconcile.test.ts` for duplicate rekeying,
      stale-running terminal updates, and retention pruning from the spec scenarios.
- [x] 1.4 GREEN/REFACTOR: update `src/state.ts` and `src/reconcile.ts` to preserve synthetic rows,
      rekey counted executions once, and prune old terminal rows safely.

## Phase 2: Token Hydration / Rendering

- [x] 2.1 RED: add failing token hydration cases in `src/logs.test.ts` for recoverable
      totals/context and empty-token fallthrough.
- [x] 2.2 GREEN: update `src/logs.ts` to port upstream-compatible token extraction and throttled
      done-row hydration.
- [x] 2.3 RED: create `src/render.test.ts` for duplicate collapse, recent terminal visibility,
      compact token/context text, and status coloring.
- [x] 2.4 GREEN: create `src/render.ts` with pure visibility, formatting, and statusline helpers
      consumed by the mouse-only UI.

## Phase 3: TUI Integration / Mouse-Only Behavior

- [x] 3.1 RED: extend `src/tui.test.ts` for clickable child navigation, aggregate counts, persisted
      status text, and keyboard-noop behavior.
- [x] 3.2 GREEN: refactor `src/tui.tsx` to apply events, hydrate snapshots, use `render.ts`, and
      keep navigation mouse-only.
- [x] 3.3 REFACTOR: remove duplicated inline render/state helpers from `src/tui.tsx` once tests pass
      and verify no keyboard/focus imports exist.

## Phase 4: Verification / Packaging

- [x] 4.1 Run `vitest run` in `tui-plugins/mrjmpl3-subagent-status` and fix any regressions in the
      touched tests only.
- [x] 4.2 Run `tsc --noEmit -p tsconfig.json` in `tui-plugins/mrjmpl3-subagent-status` and clean up
      type drift from the sync.
