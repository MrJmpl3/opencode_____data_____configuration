# Delta for mrjmpl3-subagent-status

## MODIFIED Requirements

### Requirement: Accurate child-session reconciliation

The system MUST normalize incoming child snapshots into stable rows, count each execution once, and
resolve fallback/session duplicates to a single execution. It MUST preserve terminal rows once
completed or errored, and newer running evidence MUST NOT regress a terminal row or resume elapsed
time. Event-path handling MUST treat `session.idle` as non-terminal unless separate authoritative
completion or error evidence is present. (Previously: the requirement preserved terminal rows, but
it did not explicitly forbid `session.idle` from terminalizing a child on the event path.)

#### Scenario: Duplicate fallback row is rekeyed once

- GIVEN a fallback row and a real session row describe the same child work
- WHEN the next snapshot is reconciled
- THEN the plugin MUST keep one visible execution
- AND total executed MUST remain unchanged

#### Scenario: Stale running row becomes terminal

- GIVEN a row is still marked running but newer child-session information indicates completion or
  failure
- WHEN the plugin refreshes
- THEN the row MUST update to the terminal status
- AND its elapsed time MUST stop advancing

#### Scenario: Old terminal rows are removed safely

- GIVEN terminal rows are older than the retention window
- WHEN state is loaded or refreshed
- THEN those rows MUST be pruned from the visible list
- AND recent terminal rows MUST remain visible

#### Scenario: Idle-only event keeps the child non-terminal

- GIVEN a child row exists for a delegated session
- WHEN the event path receives only `session.idle` for that session
- THEN the row MUST remain `running`
- AND `endedAt` MUST remain unset

#### Scenario: Later completion evidence terminalizes an idle child

- GIVEN a child row previously saw `session.idle` without terminalizing
- WHEN later `session.status` or recovery/message evidence explicitly indicates completion
- THEN the row MUST update to `done`
- AND the terminal timestamp MUST come from that later evidence

#### Scenario: Later error evidence overrides prior idle-only state

- GIVEN a child row previously saw `session.idle` without terminalizing
- WHEN later `session.error` or equivalent authoritative error evidence arrives
- THEN the row MUST update to `error`
- AND the row MUST NOT remain stuck in a false done state
