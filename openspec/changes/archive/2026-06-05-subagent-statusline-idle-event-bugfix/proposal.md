# Proposal: Subagent Statusline Idle Event Bugfix

## Intent

Fix the confirmed event-path bug where `session.idle` in
`tui-plugins/mrjmpl3-subagent-status/src/events.ts` is treated as `done`, causing a false terminal
state that can stick before authoritative completion or error evidence arrives. This must land
before the broader status architecture refactor so the refactor starts from correct terminal-state
semantics instead of preserving known bad behavior.

## Proposal question round

- Confirmed assumption: `session.idle` alone is not a completion signal.
- Confirmed assumption: temporarily showing `running` is safer than falsely showing `done`.
- Confirmed assumption: persistence, rendering, retention, and refactor work stay unchanged in this
  slice.

## Scope

### In Scope

- Stop mapping `session.idle` directly to `done` in the event path.
- Keep `session.error` and explicit status-derived terminal handling unchanged.
- Add focused regression coverage for idle-only event handling in `src/events.test.ts`.

### Out of Scope

- Broader subagent-status architecture refactor.
- Refresh, reconcile, persistence, retention, or panel-rendering changes beyond alignment.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `mrjmpl3-subagent-status`: event-driven child status updates must not treat `session.idle` as
  terminal without authoritative completion or error evidence.

## Approach

Apply the minimal event-mapping fix in `applySubagentEvent`: treat `session.idle` as non-terminal,
update row details only, and continue relying on explicit completion/error evidence from
`session.status`, `session.error`, refresh recovery, or message-derived signals for terminalization.

## Affected Areas

| Area                                                     | Impact   | Description                                                  |
| -------------------------------------------------------- | -------- | ------------------------------------------------------------ |
| `tui-plugins/mrjmpl3-subagent-status/src/events.ts`      | Modified | Remove idle→done terminalization.                            |
| `tui-plugins/mrjmpl3-subagent-status/src/events.test.ts` | Modified | Add regression coverage for idle-only events.                |
| `openspec/specs/mrjmpl3-subagent-status/spec.md`         | Modified | Clarify idle-only event behavior in the existing capability. |

## Risks

| Risk                                                         | Likelihood | Mitigation                                                                    |
| ------------------------------------------------------------ | ---------- | ----------------------------------------------------------------------------- |
| Some edge flow relied on idle as the only completion signal. | Low        | Keep change narrow and cover explicit terminal evidence paths in tests/specs. |

## Rollback Plan

Revert the `events.ts` mapping change and its regression test if downstream evidence proves an
unsupported flow depends on idle-as-done.

## Dependencies

- Existing authoritative terminal-state semantics in `src/reconcile.ts` and `src/refresh.ts` remain
  the source of truth.

## Success Criteria

- [ ] Idle-only events no longer mark a child row `done`.
- [ ] Explicit completion or error evidence still terminalizes the row correctly.
- [ ] The bugfix remains reviewable as a narrow pre-refactor slice.
