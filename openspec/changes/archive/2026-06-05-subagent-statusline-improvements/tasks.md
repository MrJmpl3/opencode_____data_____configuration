# Tasks: Subagent Statusline Improvements

## Review Workload Forecast

| Field                   | Value              |
| ----------------------- | ------------------ |
| Estimated changed lines | 520-680            |
| 400-line budget risk    | High               |
| Chained PRs recommended | Yes                |
| Suggested split         | PR 1 → PR 2 → PR 3 |
| Delivery strategy       | ask-always         |
| Chain strategy          | pending            |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

### Suggested Work Units

| Unit | Goal                                   | Likely PR | Notes                                                                                  |
| ---- | -------------------------------------- | --------- | -------------------------------------------------------------------------------------- |
| 1    | Terminal-state and counting semantics  | PR 1      | Base = tracker branch; include `state.ts`, `reconcile.ts`, and matching tests.         |
| 2    | Recovery hydration, including SQLite   | PR 2      | Base = PR 1 branch; add `src/recovery.ts`/`src/recovery/sqlite.ts` and refresh wiring. |
| 3    | Persistence hardening and prune safety | PR 3      | Base = PR 2 branch; keep JSON compatibility and non-resurrection guarantees.           |

## Phase 1: Foundation / Recovery

- [x] 1.1 Add a `RecoverySource` seam in `src/recovery.ts` and a SQLite-backed adapter in `src/recovery/sqlite.ts` to hydrate authoritative state before log token fallback.
- [x] 1.2 Update `src/persistence.ts` load helpers so recovered rows can replace stale legacy rows without breaking the existing state.json format.

## Phase 2: Core State Semantics

- [x] 2.1 Update `src/state.ts` to preserve terminal rows, freeze `elapsedMs` after done/error, and bound stale-row retention without reviving purged rows.
- [x] 2.2 Update `src/reconcile.ts` so completion/error evidence terminalizes rows, delegation rows stay out of totals, and duplicate fallback/session executions count once.
- [x] 2.3 Wire recovery ordering in `src/refresh.ts`: SQLite/JSON recovery first, then token hydration, then prune.

## Phase 3: Testing / Verification

- [x] 3.1 Extend `src/state.test.ts` with done→running regression, frozen elapsed-time, and prune/non-resurrection cases.
- [x] 3.2 Extend `src/reconcile.test.ts` with terminal evidence promotion, delegation exclusion, and duplicate execution dedupe cases.
- [x] 3.3 Add `src/refresh.test.ts` coverage for SQLite-backed hydration and stale-local override, plus a new recovery-focused test file if needed.
- [x] 3.4 Add `src/persistence.test.ts` coverage for backward-compatible load/save and bounded purge behavior.

## Phase 4: Cleanup / Guardrails

- [x] 4.1 Remove any obsolete recovery branches or duplicate helpers after the new adapter and tests are stable.
