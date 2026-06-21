# Design: Subagent Statusline Idle Event Bugfix

## Technical Approach

Apply a narrow fix in `tui-plugins/mrjmpl3-subagent-status/src/events.ts` so `applySubagentEvent` no
longer terminalizes a child on `session.idle`. The event path will keep using `session.error` and
explicit `session.status` terminal values for completion, which matches the already-correct
semantics in `reconcile.ts` and `refresh.ts`. No folder moves, runtime reorganization, persistence
changes, or recovery changes are part of this design.

## Architecture Decisions

### Decision: Treat `session.idle` as observational, not terminal

| Option                                               | Tradeoff                                                      | Decision | Rationale                                                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| Keep `idle -> done`                                  | Simple branch, but preserves the confirmed false terminal bug | Rejected | Conflicts with the spec and can leave rows stuck as `done` before authoritative evidence arrives |
| Ignore idle for status but still merge child details | Small code change, preserves existing event pipeline          | Chosen   | Fixes the bug while keeping the patch narrow and reviewable before the refactor                  |

### Decision: Preserve existing terminal authorities

| Option                                                                                                         | Tradeoff                                                             | Decision | Rationale                                                                              |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------- |
| Redesign all event/status reconciliation together                                                              | Better long-term shape, but overlaps the pending architecture change | Rejected | Violates the requested narrow pre-refactor scope                                       |
| Keep `session.error`, explicit `session.status`, and refresh/recovery signals as the only terminal authorities | Leaves current structure in place                                    | Chosen   | Aligns event handling with `refresh.ts` and `reconcile.ts` without widening the change |

## Data Flow

`refresh.ts` clones state, applies an event, prunes stale terminal rows, and syncs the result.

```text
runtime event bridge
  -> mergeEventState(event)
    -> applySubagentEvent(nextState, event)
      -> session.idle   => merge details only
      -> session.status => derive status, mark done/error when terminal
      -> session.error  => mark error
    -> pruneTerminalChildren(nextState)
    -> syncState(nextState)
```

This keeps refresh/reconcile semantics aligned: idle-only evidence never sets `endedAt`, while later
authoritative evidence still terminalizes the same row through `markChildStatus`.

## File Changes

| File                                                     | Action | Description                                                                                                                                                                             |
| -------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tui-plugins/mrjmpl3-subagent-status/src/events.ts`      | Modify | Remove idle-driven terminalization inside the `session.idle/session.error/session.status` branch while preserving detail updates and existing terminal handling for error/status events |
| `tui-plugins/mrjmpl3-subagent-status/src/events.test.ts` | Modify | Add focused regression tests for idle-only events and for later authoritative terminal evidence after an idle event                                                                     |

## Interfaces / Contracts

No new public interfaces are required. The behavioral contract for `applySubagentEvent` becomes:

```ts
// session.idle
// - MUST NOT call markChildStatus(..., 'done', ...)
// - MAY merge title/summary/agent metadata for an existing child
// - MUST leave status='running' and endedAt undefined
```

Existing state shapes remain unchanged:

```ts
type SubagentStatus = 'running' | 'done' | 'error';
interface SubagentChild {
  status: SubagentStatus;
  endedAt?: string;
}
```

## Testing Strategy

| Layer       | What to Test                             | Approach                                                                                                                                       |
| ----------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | Idle-only event on an existing child row | In `src/events.test.ts`, seed a running session child, apply `session.idle`, assert `status` stays `running` and `endedAt` stays unset         |
| Unit        | Later completion after prior idle        | In `src/events.test.ts`, apply `session.idle` then `session.status` with a done value, assert the row becomes `done` with a terminal timestamp |
| Unit        | Later error after prior idle             | In `src/events.test.ts`, apply `session.idle` then `session.error`, assert the row becomes `error` and does not remain falsely done            |
| Integration | None                                     | Keep the slice narrow; `refresh.ts` and `reconcile.ts` behavior is preserved, not redesigned                                                   |
| E2E         | None                                     | No E2E harness exists for this package                                                                                                         |

## Migration / Rollout

No migration required. Rollout is a single small patch in the plugin package and should land before
the architecture reorganization.

## Open Questions

- [ ] None.
