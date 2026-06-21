# Tasks: Subagent Statusline Idle Event Bugfix

## Review Workload Forecast

| Field                   | Value      |
| ----------------------- | ---------- |
| Estimated changed lines | 40-110     |
| 400-line budget risk    | Low        |
| Chained PRs recommended | No         |
| Suggested split         | Single PR  |
| Delivery strategy       | ask-always |
| Chain strategy          | pending    |

Decision needed before apply: Yes Chained PRs recommended: No Chain strategy: pending 400-line
budget risk: Low

### Suggested Work Units

| Unit | Goal                                                          | Likely PR | Notes                                                                                                   |
| ---- | ------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------- |
| 1    | Fix idle-event terminalization and add event-path regressions | PR 1      | Keep diff inside `src/events.ts` and `src/events.test.ts`; verify with package-local test and typecheck |

## Phase 1: RED - Event-path regressions

- [x] 1.1 In `tui-plugins/mrjmpl3-subagent-status/src/events.test.ts`, add a failing test that seeds
      an existing `ses_child` row, applies `session.idle`, and asserts `status` stays `running` with
      `endedAt` unset.
- [x] 1.2 In `tui-plugins/mrjmpl3-subagent-status/src/events.test.ts`, add a failing test that
      applies `session.idle` then `session.status` with explicit done evidence and asserts the later
      event sets `done` and the terminal timestamp.
- [x] 1.3 In `tui-plugins/mrjmpl3-subagent-status/src/events.test.ts`, add a failing test that
      applies `session.idle` then `session.error` and asserts the row becomes `error`, not false
      `done`.

## Phase 2: GREEN - Narrow event fix

- [x] 2.1 In `tui-plugins/mrjmpl3-subagent-status/src/events.ts`, change `applySubagentEvent` so
      `session.idle` updates child details only and never calls `markChildStatus(..., 'done', ...)`.
- [x] 2.2 In `tui-plugins/mrjmpl3-subagent-status/src/events.ts`, preserve existing terminal
      handling for `session.status` and `session.error`, including `endedAt` extraction and detail
      merges for the same `sessionID`.

## Phase 3: REFACTOR - Scope guard

- [x] 3.1 In `tui-plugins/mrjmpl3-subagent-status/src/events.ts` and `src/events.test.ts`, remove
      only duplication introduced by the fix if idle/status/error branches stay behaviorally
      identical.
- [x] 3.2 Confirm this slice does not modify `tui-plugins/mrjmpl3-subagent-status/src/refresh.ts`,
      `src/reconcile.ts`, or persistence/recovery code.

## Phase 4: Verification

- [x] 4.1 Run `npm test` in `tui-plugins/mrjmpl3-subagent-status` and verify the new idle-event
      regressions pass.
- [x] 4.2 Run `npm run typecheck` in `tui-plugins/mrjmpl3-subagent-status` and verify the event-path
      patch remains type-safe.
