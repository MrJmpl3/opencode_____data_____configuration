# subagent-statusline-state-and-recovery Specification

## Purpose

Keep subagent status data accurate when events arrive out of order, recovery data is partial, or
legacy state is stale, while preserving the current mouse-only statusline UX.

## Requirements

### Requirement: Terminal-preserving reconciliation

The system MUST preserve terminal state once a row has been marked completed or errored. New running
evidence MUST NOT regress a terminal row, and elapsed-time display MUST stop advancing after
terminalization.

#### Scenario: New running evidence does not reopen a finished row

- GIVEN a row is already completed
- WHEN a later snapshot reports the same row as running
- THEN the row MUST remain completed
- AND its elapsed time MUST NOT resume

#### Scenario: Terminal evidence updates a stale row

- GIVEN a row is still shown as running
- WHEN completion or error evidence is reconciled for that row
- THEN the row MUST become terminal
- AND the terminal status MUST be preserved on refresh

### Requirement: Completion propagation and counting semantics

The system MUST terminalize task and subtask rows when completion evidence is observed. It MUST
exclude delegation-style rows from execution totals and MUST count each execution only once, even
when duplicate fallback or session rows appear.

#### Scenario: Delegation rows are excluded from totals

- GIVEN the visible set contains a delegation-style row and a task row
- WHEN totals are calculated
- THEN the delegation-style row MUST NOT contribute to total executed
- AND the task row MUST count once

#### Scenario: Duplicate execution evidence is not double-counted

- GIVEN fallback and session snapshots describe the same completed work
- WHEN the snapshots are reconciled
- THEN the work MUST be represented as one execution
- AND total executed MUST remain stable

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

## Non-goals

- Keyboard shortcuts, focus management, and other non-mouse interaction layers.
- Broad rendering or layout changes unrelated to state correctness.
- A full upstream parity rewrite beyond the state and recovery semantics above.
