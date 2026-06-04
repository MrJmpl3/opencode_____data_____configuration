# Apply Progress: sync-mrjmpl3-subagent-status-upstream-without-keyboard

## Slice

- Delivery mode: size:exception accepted
- Internal slice: Slice 5 = verify remediation for statusline/count drift and runtime proof gaps
- Mode: Strict TDD

## Completed Tasks

- [x] 1.1 RED: add failing cases in `src/events.test.ts` for subtask/tool parsing, ambiguous event ignore, and target-session mapping.
- [x] 1.2 GREEN: extend `src/types.ts` and `src/events.ts` with upstream-derived child fields and `applySubagentEvent()` without keyboard hooks.
- [x] 1.3 RED: extend `src/state.test.ts` and `src/reconcile.test.ts` for duplicate rekeying, stale-running terminal updates, and retention pruning from the spec scenarios.
- [x] 1.4 GREEN/REFACTOR: update `src/state.ts` and `src/reconcile.ts` to preserve synthetic rows, rekey counted executions once, and prune old terminal rows safely.
- [x] 2.1 RED: add failing token hydration cases in `src/logs.test.ts` for recoverable totals/context and empty-token fallthrough.
- [x] 2.2 GREEN: update `src/logs.ts` to port upstream-compatible token extraction and throttled done-row hydration.
- [x] 2.3 RED: create `src/render.test.ts` for duplicate collapse, recent terminal visibility, compact token/context text, and status coloring.
- [x] 2.4 GREEN: create `src/render.ts` with pure visibility, formatting, and statusline helpers consumed by the mouse-only UI.
- [x] 3.1 RED: extend `src/tui.test.ts` for clickable child navigation, aggregate counts, persisted status text, and keyboard-noop behavior.
- [x] 3.2 GREEN: refactor `src/tui.tsx` to apply events, hydrate snapshots, use `render.ts`, and keep navigation mouse-only.
- [x] 3.3 REFACTOR: remove duplicated inline render/state helpers from `src/tui.tsx` once tests pass and verify no keyboard/focus imports exist.
- [x] 4.1 Run `vitest run` in `tui-plugins/mrjmpl3-subagent-status` and fix any regressions in the touched tests only.
- [x] 4.2 Run `tsc --noEmit -p tsconfig.json` in `tui-plugins/mrjmpl3-subagent-status` and clean up type drift from the sync.

## TDD Cycle Evidence

| Task | Test File                                    | Layer        | Safety Net                                                        | RED                             | GREEN                            | TRIANGULATE             | REFACTOR                                                                            |
| ---- | -------------------------------------------- | ------------ | ----------------------------------------------------------------- | ------------------------------- | -------------------------------- | ----------------------- | ----------------------------------------------------------------------------------- |
| 1.1  | `src/events.test.ts`                         | Unit         | N/A (new)                                                         | ✅ Written                      | ✅ Passed                        | ✅ 3 cases              | ➖ None needed                                                                      |
| 1.2  | `src/events.test.ts`                         | Unit         | N/A (new)                                                         | ✅ Written                      | ✅ Passed                        | ✅ 3 cases              | ✅ Applied while extracting helpers                                                 |
| 1.3  | `src/state.test.ts`, `src/reconcile.test.ts` | Unit         | ✅ `src/state.test.ts` + `src/reconcile.test.ts` baseline passing | ✅ Written                      | ✅ Passed                        | ✅ 4 cases              | ➖ None needed                                                                      |
| 1.4  | `src/state.test.ts`, `src/reconcile.test.ts` | Unit         | ✅ `src/state.test.ts` + `src/reconcile.test.ts` baseline passing | ✅ Written                      | ✅ Passed                        | ✅ 4 cases              | ✅ Applied while simplifying reconciliation                                         |
| 2.1  | `src/logs.test.ts`                           | Unit         | ✅ `src/logs.test.ts` baseline passing                            | ✅ Written                      | ✅ Passed                        | ✅ 3 cases              | ➖ None needed                                                                      |
| 2.2  | `src/logs.test.ts`                           | Unit         | ✅ `src/logs.test.ts` baseline passing                            | ✅ Written                      | ✅ Passed                        | ✅ 3 cases              | ✅ Applied while extracting nested token hints                                      |
| 2.3  | `src/render.test.ts`                         | Unit         | N/A (new)                                                         | ✅ Written                      | ✅ Passed                        | ✅ 4 cases              | ➖ None needed                                                                      |
| 2.4  | `src/render.test.ts`                         | Unit         | N/A (new)                                                         | ✅ Written                      | ✅ Passed                        | ✅ 4 cases              | ✅ Applied while extracting pure render helpers                                     |
| 3.1  | `src/tui.test.ts`                            | Unit         | ⚠️ Baseline exposed existing count/status drift in snapshot text  | ✅ Written                      | ✅ Passed                        | ✅ 5 cases              | ➖ None needed                                                                      |
| 3.2  | `src/tui.test.ts`                            | Unit         | ⚠️ Baseline exposed existing count/status drift in snapshot text  | ✅ Written                      | ✅ Passed                        | ✅ 5 cases              | ✅ Applied while wiring event snapshots with the same `nowMs` used for visible rows |
| 3.3  | `src/tui.test.ts`                            | Unit         | ⚠️ Baseline exposed existing count/status drift in snapshot text  | ✅ Written                      | ✅ Passed                        | ✅ 5 cases              | ✅ Kept mouse-only navigation proof isolated from count/status assertions           |
| 4.1  | `vitest run`                                 | Verification | ⚠️ Baseline exposed existing suite failures in `tui.test.ts`      | ✅ Added runtime proof first    | ✅ `PASS (25) FAIL (0)`          | ✅ Re-ran full package  | ✅ Minimal follow-up in `src/tui.tsx` and `src/reconcile.ts` fixed time-based drift |
| 4.2  | `tsc --noEmit -p tsconfig.json`              | Verification | ✅ Existing types aligned before task close                       | ➖ N/A — verification-only task | ✅ `TypeScript: No errors found` | ➖ Single compiler path | ➖ No code changes required                                                         |

## Verification

- `cd tui-plugins/mrjmpl3-subagent-status && vitest run` ✅ Passed
  - Output: `PASS (25) FAIL (0)`
- `cd tui-plugins/mrjmpl3-subagent-status && tsc --noEmit -p tsconfig.json` ✅ Passed
  - Output: `TypeScript: No errors found`

## Notes

- Scope remained limited to verify remediation on `main` with size:exception already accepted.
- Added a dedicated runtime test proving a completed row without token metadata still renders and leaves the token area empty.
- `src/tui.tsx` now passes the same snapshot `nowMs` into `renderStatusLine()` so rendered counts match the already-filtered visible children.
- `src/reconcile.ts` now prunes terminal rows against the snapshot timestamp instead of ambient wall-clock time, preventing fixture-time drift during reconciliation tests.
- No keyboard or focus behavior was introduced; the existing mouse-only navigation/runtime test still passes unchanged.
