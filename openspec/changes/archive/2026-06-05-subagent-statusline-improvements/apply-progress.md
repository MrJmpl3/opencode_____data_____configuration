# Apply Progress: subagent-statusline-improvements

## Slice

- Delivery mode: local stacked slices
- Chain strategy: stacked-to-main
- Internal slice: remediation = materialize merged Strict TDD evidence for verification
- Mode: Strict TDD

## Completed Tasks

- [x] 1.1 Add a `RecoverySource` seam in `src/recovery.ts` and a SQLite-backed adapter in
      `src/recovery/sqlite.ts` to hydrate authoritative state before log token fallback.
- [x] 1.2 Update `src/persistence.ts` load helpers so recovered rows can replace stale legacy rows
      without breaking the existing state.json format.
- [x] 2.1 Update `src/state.ts` to preserve terminal rows, freeze `elapsedMs` after done/error, and
      bound stale-row retention without reviving purged rows.
- [x] 2.2 Update `src/reconcile.ts` so completion/error evidence terminalizes rows, delegation rows
      stay out of totals, duplicate fallback/session executions count once, and `idle` no longer
      terminalizes rows without explicit terminal evidence.
- [x] 2.3 Wire recovery ordering in `src/refresh.ts`: SQLite/JSON recovery first, then token
      hydration, then prune, while preventing idle-only status hydration from closing rows.
- [x] 3.1 Extend `src/state.test.ts` with done→running regression, frozen elapsed-time, and
      prune/non-resurrection cases.
- [x] 3.2 Extend `src/reconcile.test.ts` with terminal evidence promotion, delegation exclusion,
      duplicate execution dedupe cases, and idle-without-terminal-evidence regression coverage.
- [x] 3.3 Add `src/refresh.test.ts` coverage for SQLite-backed hydration, stale-local override,
      idle-only refresh regression, and explicit completion-evidence refresh behavior.
- [x] 3.4 Add `src/persistence.test.ts` coverage for backward-compatible load/save and bounded purge
      behavior.
- [x] 4.1 Remove any obsolete recovery branches or duplicate helpers after the new adapter and tests
      are stable.

## TDD Cycle Evidence

| Task        | Test File                                         | Layer | Safety Net                        | RED        | GREEN     | TRIANGULATE | REFACTOR |
| ----------- | ------------------------------------------------- | ----- | --------------------------------- | ---------- | --------- | ----------- | -------- |
| 1.1         | `src/recovery.test.ts`, `src/refresh.test.ts`     | Unit  | ✅ `src/refresh.test.ts` 1/1      | ✅ Written | ✅ Passed | ✅ 3 cases  | ✅ Clean |
| 1.2         | `src/persistence.test.ts`                         | Unit  | N/A (new)                         | ✅ Written | ✅ Passed | ✅ 2 cases  | ✅ Clean |
| 2.1         | `src/state.test.ts`                               | Unit  | ✅ 9/9                            | ✅ Written | ✅ Passed | ✅ 2 cases  | ✅ Clean |
| 2.2         | `src/reconcile.test.ts`, `src/state.test.ts`      | Unit  | ✅ `src/reconcile.test.ts` 6/6    | ✅ Written | ✅ Passed | ✅ 5 cases  | ✅ Clean |
| 2.3         | `src/refresh.test.ts`                             | Unit  | ✅ 1/1                            | ✅ Written | ✅ Passed | ✅ 4 cases  | ✅ Clean |
| 3.1         | `src/state.test.ts`                               | Unit  | ✅ 9/9                            | ✅ Written | ✅ Passed | ✅ 2 cases  | ✅ Clean |
| 3.2         | `src/reconcile.test.ts`                           | Unit  | ✅ 6/6                            | ✅ Written | ✅ Passed | ✅ 5 cases  | ✅ Clean |
| 3.3         | `src/recovery.test.ts`, `src/refresh.test.ts`     | Unit  | ✅ `src/refresh.test.ts` 1/1      | ✅ Written | ✅ Passed | ✅ 4 cases  | ✅ Clean |
| 3.4         | `src/persistence.test.ts`                         | Unit  | N/A (new)                         | ✅ Written | ✅ Passed | ✅ 2 cases  | ✅ Clean |
| 4.1         | `src/recovery.test.ts`, `src/persistence.test.ts` | Unit  | ✅ existing targeted suites green | ✅ Written | ✅ Passed | ✅ 2 cases  | ✅ Clean |
| remediation | `src/reconcile.test.ts`, `src/refresh.test.ts`    | Unit  | ✅ 10/10                          | ✅ Written | ✅ Passed | ✅ 3 cases  | ✅ Clean |

## Test Summary

- Total tests written: 13
- Total tests passing: 12 targeted in the remediation slice; the original apply batch remained green
  when completed
- Layers used: Unit only
- Approval tests: None
- Pure functions created: 0

## Remediation Batch — Idle status regression

- Baseline safety net: `npm test -- src/reconcile.test.ts src/refresh.test.ts` → 10/10 passing
  before edits.
- RED: Added regressions proving idle-only snapshots and hydration must keep rows running, while
  explicit completion evidence still terminalizes them.
- GREEN: Removed `idle` from reconcile/client done mappings and required explicit completion or
  explicit terminal statuses during TUI refresh hydration.
- TRIANGULATE: Preserved explicit completion behavior with companion refresh coverage and updated an
  older prune test to use actual terminal evidence (`done`) instead of `idle`.
- REFACTOR: Kept the code change minimal; this artifact remediation only materializes the merged
  apply evidence required by Strict TDD verification.

## Verification

- `npm test` ✅ Passed previously for `tui-plugins/mrjmpl3-subagent-status`
  - Output captured in `verify-report.md`: `58 passed / 0 failed / 0 skipped`
- `npm run typecheck` ✅ Passed previously
  - Output captured in `verify-report.md`: `tsc --noEmit -p tsconfig.json`

## Notes

- This file materializes the previously saved Engram apply-progress memory into the standard
  OpenSpec artifact location required by Strict TDD verification.
- The merged evidence includes both the original apply batch and the follow-up idle→done remediation
  evidence.
- No product code was changed in this remediation batch.
- The authoritative memory sources used were `sdd/subagent-statusline-improvements/apply-progress`
  and `sdd/subagent-statusline-improvements/idle-done-bugfix`.

## Status

10/10 tasks complete. Strict TDD evidence is now present in OpenSpec format and ready for verify.
