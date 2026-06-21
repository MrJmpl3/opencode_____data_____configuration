# mrjmpl3-subagent-status Specification

## Purpose

Provide a mouse-only subagent status panel that keeps child sessions in sync, preserves terminal
rows through out-of-order updates, enriches finished rows with token/context data when available,
and renders clickable status rows without keyboard or focus controls.

## Requirements

### Requirement: Accurate child-session reconciliation

The system MUST normalize incoming child snapshots into stable rows, count each execution once, and
resolve fallback/session duplicates to a single execution. It MUST preserve terminal rows once
completed or errored, and newer running evidence MUST NOT regress a terminal row or resume elapsed
time. Event-path handling MUST treat `session.idle` as non-terminal unless separate authoritative
completion or error evidence is present.

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

### Requirement: Token and context hydration

The system MUST hydrate completed child rows with token totals or context percentage when
recoverable. If no usable token data exists, the row MUST still render without token metadata.

#### Scenario: Completed row shows token metadata

- GIVEN a completed child row has recoverable token totals
- WHEN the plugin refreshes
- THEN the row MUST display token or context metadata
- AND its status MUST remain completed or errored

#### Scenario: No token data does not block rendering

- GIVEN a completed child row has no recoverable token data
- WHEN the plugin refreshes
- THEN the row MUST still render
- AND the token area MUST remain empty

### Requirement: Recovery hydration prefers authoritative state

The system MUST hydrate missing state and token metadata from the best available recovery source.
When recovery data conflicts with stale local legacy rows, the recovery state MUST win and the stale
row SHOULD be replaced or removed.

#### Scenario: Recovery fills missing token metadata

- GIVEN local state is missing token or session metadata
- WHEN a recovery source provides that metadata
- THEN the row MUST be hydrated with the recovered values
- AND the row MUST remain visible

#### Scenario: Recovery overrides stale local running state

- GIVEN local state shows a row as running
- WHEN recovery data shows the same row as terminal
- THEN the terminal recovery state MUST win
- AND the stale running state MUST NOT be restored

### Requirement: Stale-row retention is bounded

The system MUST bound retention of stale or incorrect legacy rows. If a row cannot be reconciled to
an accurate state, the system MAY purge it instead of preserving incorrect visible state, and purged
rows MUST NOT be resurrected by later stale snapshots.

#### Scenario: Irreconcilable legacy row is purged

- GIVEN a legacy row cannot be matched to a current authoritative state
- WHEN state is loaded or refreshed
- THEN the row MAY be removed from visible state
- AND the incorrect row MUST NOT remain visible

#### Scenario: Purged rows are not brought back by stale input

- GIVEN a row has been purged as stale
- WHEN a later stale snapshot repeats the same incorrect row
- THEN the row MUST stay absent unless authoritative recovery recreates it

### Requirement: Mouse-only status rendering and navigation

The system MUST render an expandable status area with per-status counts, total executed count, and
per-row elapsed time. It MUST allow mouse navigation from clickable child rows only and MUST NOT
expose keyboard shortcuts, focus restoration, or command-palette controls.

#### Scenario: Clickable session row navigates to child session

- GIVEN a rendered row has a target session ID
- WHEN the user clicks it with the mouse
- THEN the plugin MUST navigate to that child session
- AND the row MUST keep its current visual status

#### Scenario: Counts render and keyboard input does nothing

- GIVEN the visible children include running, done, and error rows
- WHEN the plugin renders the status area or the user presses keyboard keys
- THEN the aggregate counters MUST match the visible rows
- AND no keyboard-driven control or focus behavior MUST be available
