# Design: Subagent Statusline Improvements

## Technical Approach

Make state handling terminal-preserving by default, then layer recovery hydration on top of the
existing refresh flow. The implementation stays selective: we refine `state.ts` and `reconcile.ts`,
wire recovery into `refresh.ts`, and keep persistence format compatibility so stale rows can be
pruned instead of rewritten.

## Architecture Decisions

| Decision              | Options                                                                    | Choice / Rationale                                                                                                                                       |
| --------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Terminal precedence   | Allow running evidence to reopen finished rows vs. preserve terminal state | Preserve terminal state. It fixes drift and prevents elapsed time from resuming after completion/error.                                                  |
| Counting identity     | Count every visible row vs. canonical execution key                        | Canonical execution key. Use session/target-session identity first, then fallback correlation, so duplicate fallback + session rows do not double count. |
| Recovery source order | Persisted JSON only vs. JSON + log hydration + future guarded source       | JSON + log hydration now; any SQLite-backed recovery stays optional/guarded behind a dedicated adapter seam. This avoids a new hard dependency.          |

## Data Flow

`events.ts` → `state.ts` (upsert/terminalize/count) → `reconcile.ts` (snapshot normalization) →
`refresh.ts` (authoritative status hydration + log token recovery) → `persistence.ts` (save/load +
pruning)

    Event / snapshot
         ↓

normalize + reconcile ↓ terminal-preserving merge ↓ recovery hydration (status + tokens) ↓ prune
stale / orphaned rows ↓ persist snapshot

## File Changes

| File                                                     | Action             | Description                                                                                                                                              |
| -------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tui-plugins/mrjmpl3-subagent-status/src/state.ts`       | Modify             | Add terminal-preserving merge rules, tighten execution identity/counting, keep elapsed time frozen after terminalization, and bound stale-row retention. |
| `tui-plugins/mrjmpl3-subagent-status/src/reconcile.ts`   | Modify             | Normalize incoming snapshots so completion/error evidence promotes terminal state and never regresses finished rows.                                     |
| `tui-plugins/mrjmpl3-subagent-status/src/refresh.ts`     | Modify             | Add a recovery pass after reconcile: hydrate authoritative session state first, then token metadata, then prune.                                         |
| `tui-plugins/mrjmpl3-subagent-status/src/persistence.ts` | Modify             | Keep load/save backward compatible; prefer recovered authoritative rows over stale legacy rows and preserve bounded pruning on load.                     |
| `tui-plugins/mrjmpl3-subagent-status/src/logs.ts`        | Modify (if needed) | Keep log-based token recovery as the default fallback; add a guarded seam only if SQLite recovery is introduced later.                                   |
| `tui-plugins/mrjmpl3-subagent-status/src/*.test.ts`      | Modify             | Add regression tests for terminal-to-running regressions, duplicate execution counting, recovery hydration, and purge behavior.                          |

## Interfaces / Contracts

```ts
type RecoverySource = {
  hydrateState(state: SubagentState): Promise<boolean> | boolean;
};
```

Recovery sources are ordered, best-effort, and must be safe to skip. A future SQLite adapter can
implement this interface without changing the TUI entrypoint.

## Testing Strategy

| Layer | What to Test                                                      | Approach                                                                                         |
| ----- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Unit  | Terminal rows do not reopen; elapsed time stays frozen            | `state.test.ts` / `reconcile.test.ts` with explicit done→running regressions.                    |
| Unit  | Delegation rows excluded; duplicate fallback/session counted once | `state.test.ts` verifies canonical identity and totalExecuted stability.                         |
| Unit  | Recovery hydration wins over stale local rows                     | `persistence.test`/`refresh.test` style tests for missing metadata and stale terminal conflicts. |
| Unit  | Purge is bounded and non-resurrecting                             | Assert stale legacy rows are dropped and later stale snapshots do not recreate them.             |

## Migration / Rollout

No migration required. The on-disk state shape remains readable; old rows are reconciled or purged
during load/refresh.

## Open Questions

- [ ] Do we want a future SQLite recovery adapter, or is log-based hydration sufficient for this
      plugin long-term?
