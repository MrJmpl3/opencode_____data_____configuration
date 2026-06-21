## Exploration: subagent-statusline-idle-event-bugfix

### Current State

The `mrjmpl3-subagent-status` plugin already treats `idle` as non-terminal in snapshot-based
recovery paths. `src/reconcile.ts` normalizes `idle` to `running`, and `src/refresh.ts` keeps a
child running when `idle` is the only evidence and only marks it `done` when explicit completion
evidence exists in session messages. The remaining bug is event-driven: `src/events.ts` still maps
`session.idle` directly to `done`, so an early idle event can terminalize a child before stronger
evidence arrives.

### Affected Areas

- `tui-plugins/mrjmpl3-subagent-status/src/events.ts` — current bug source; `session.idle` is
  hard-mapped to `done`.
- `tui-plugins/mrjmpl3-subagent-status/src/reconcile.ts` — establishes the intended semantics that
  `idle` alone is not terminal.
- `tui-plugins/mrjmpl3-subagent-status/src/refresh.ts` — already contains the authoritative
  refresh-side safeguard and should remain behaviorally aligned.
- `tui-plugins/mrjmpl3-subagent-status/src/refresh.test.ts` — existing tests prove the refresh path
  already handles idle-only evidence correctly.
- `tui-plugins/mrjmpl3-subagent-status/src/events.test.ts` — existing event tests should gain
  coverage for the idle-event regression path.
- `openspec/specs/mrjmpl3-subagent-status/spec.md` — baseline spec already implies terminal state
  must come from authoritative completion evidence.

### Approaches

1. **Minimal event-mapping fix** — Change `session.idle` handling in `applySubagentEvent` so idle
   does not call `markChildStatus(..., 'done', ...)`, and only updates child details.
   - Pros: Smallest and safest fix; aligns event behavior with existing refresh/reconcile logic; low
     review risk.
   - Cons: Relies on refresh/session-status/message evidence to produce terminal states later.
   - Effort: Low

2. **Event-level explicit idle normalization** — Route `session.idle` through
   `deriveOpenCodeSessionStatus` or a dedicated helper that treats idle as running/non-terminal
   across all event status parsing.
   - Pros: More explicit domain model; reduces chance of future drift if more event shapes appear.
   - Cons: Slightly broader change surface; easy to over-generalize beyond the confirmed bug.
   - Effort: Medium

### Recommendation

Use the minimal event-mapping fix. The bug is already isolated to `applySubagentEvent` in
`src/events.ts`, while `refresh.ts` and `reconcile.ts` already encode the correct behavior. The
safest direction is to stop terminalizing rows on `session.idle`, then add focused tests that prove
idle-only events keep children running until explicit completion or error evidence arrives.

### Risks

- If `session.idle` is currently the only terminal signal for some edge flow, removing the direct
  `done` mapping could delay completion until refresh or message evidence arrives.
- Without dedicated event-path tests, a future refactor could reintroduce the drift between
  `events.ts` and the other status-normalization paths.

### Ready for Proposal

Yes — propose a narrow bugfix limited to `src/events.ts` plus targeted tests for idle-event
handling. Non-goals: broader subagent status architecture refactors, persistence changes, or panel
rendering updates.
