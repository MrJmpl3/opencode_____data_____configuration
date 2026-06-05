# Proposal: Subagent Statusline Improvements

## Intent

Reduce status drift and false running states in `mrjmpl3-subagent-status` by tightening reconciliation, completion propagation, and recovery. The change should favor correct terminal state handling over preserving stale or incorrect legacy state, while keeping the plugin mouse-only.

## Scope

### In Scope

- Preserve terminal child state during reconciliation and prevent completed/error rows from regressing to running.
- Align delegation counting and task/subtask completion handling with upstream-safe behavior.
- Improve state/token recovery, including evaluating the remote repository’s recovery approach where useful.

### Out of Scope

- Keyboard shortcuts, focus management, or any non-mouse interaction model.
- Broad UI/statusline rendering changes unrelated to state correctness.
- Full upstream parity rewrite or unrelated package refactors.

## Capabilities

### New Capabilities

- `subagent-statusline-state-and-recovery`: terminal-preserving reconciliation, stale-row retention limits, delegation counting, and recovery hydration.

### Modified Capabilities

None.

## Approach

Keep the current TUI entrypoint and update the pure state/reconcile/persistence helpers first. Prefer upstream-aligned transition rules where they measurably fix bugs, and allow stale or incorrect rows to be purged rather than retained. Add targeted tests for regression cases before changing behavior.

## Affected Areas

| Area                                                     | Impact   | Description                                                              |
| -------------------------------------------------------- | -------- | ------------------------------------------------------------------------ |
| `tui-plugins/mrjmpl3-subagent-status/src/state.ts`       | Modified | Terminal-preserving state transitions, execution counting, pruning rules |
| `tui-plugins/mrjmpl3-subagent-status/src/reconcile.ts`   | Modified | Incoming event normalization and child-state reconciliation              |
| `tui-plugins/mrjmpl3-subagent-status/src/persistence.ts` | Modified | State load/save and recovery hydration path                              |
| `tui-plugins/mrjmpl3-subagent-status/src/*.test.ts`      | Modified | Regression coverage for stale-state, completion, and recovery cases      |

## Risks

| Risk                                  | Likelihood | Mitigation                                                      |
| ------------------------------------- | ---------- | --------------------------------------------------------------- |
| Over-pruning hides useful history     | Med        | Keep retention bounded and test retention edge cases            |
| Recovery fallback is not portable     | Med        | Treat SQLite/recovery support as optional and guarded           |
| Counting semantics shift unexpectedly | Med        | Add explicit regression tests for delegation/task/subtask cases |

## Rollback Plan

Revert the state/reconcile/persistence changes and any new recovery fallback. The on-disk state format should remain readable so rollback can fall back to the previous hydration and pruning behavior without a migration.

## Dependencies

- Existing `mrjmpl3-subagent-status` runtime and local filesystem state directory.
- Optional access to the remote-repository recovery source if the fallback is adopted.

## Success Criteria

- [ ] Terminal children do not regress to running after completion evidence arrives.
- [ ] Delegation-style rows are excluded from execution counts, and completion propagation is covered by tests.
- [ ] Recovery hydrates state more accurately without reintroducing stale or incorrect rows.
