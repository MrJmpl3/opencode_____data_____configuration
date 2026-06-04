# mrjmpl3-subagent-status Specification

## Purpose

Provide a mouse-only subagent status panel that keeps child sessions in sync, enriches finished rows with token/context data when available, and renders clickable status rows without keyboard or focus controls.

## Requirements

### Requirement: Accurate child-session reconciliation

The system MUST normalize incoming child snapshots into stable rows, count each execution once, and resolve fallback/session duplicates to a single execution. It MUST update stale running rows to their latest terminal status when newer child-session information indicates completion or failure.

#### Scenario: Duplicate fallback row is rekeyed once

- GIVEN a fallback row and a real session row describe the same child work
- WHEN the next snapshot is reconciled
- THEN the plugin MUST keep one visible execution
- AND total executed MUST remain unchanged

#### Scenario: Stale running row becomes terminal

- GIVEN a row is still marked running but newer child-session information indicates idle, done, or error
- WHEN the plugin refreshes
- THEN the row MUST update to the terminal status
- AND its elapsed time MUST stop advancing

#### Scenario: Old terminal rows are removed safely

- GIVEN terminal rows are older than the retention window
- WHEN state is loaded or refreshed
- THEN those rows MUST be pruned from the visible list
- AND recent terminal rows MUST remain visible

### Requirement: Token and context hydration

The system MUST hydrate completed child rows with token totals or context percentage when recoverable. If no usable token data exists, the row MUST still render without token metadata.

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

### Requirement: Mouse-only status rendering and navigation

The system MUST render an expandable status area with per-status counts, total executed count, and per-row elapsed time. It MUST allow mouse navigation from clickable child rows only and MUST NOT expose keyboard shortcuts, focus restoration, or command-palette controls.

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
