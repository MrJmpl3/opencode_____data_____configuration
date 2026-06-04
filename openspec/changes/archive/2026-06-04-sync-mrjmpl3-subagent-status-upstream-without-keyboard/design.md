# Design: Sync mrjmpl3 subagent status upstream without keyboard

## Technical Approach

Use a selective upstream core port inside `tui-plugins/mrjmpl3-subagent-status` while keeping the local plugin shell unchanged: `index.tsx` stays the entrypoint, `src/tui.tsx` stays the only TUI module, and navigation remains mouse-only. The port will import upstream ideas from `events`, `state`, `reconcile`, `render`, and token hydration, but it will explicitly exclude `tui-commands`, `tui-focus`, `useKeyboard`, focus restoration, and command-palette registration.

No delta specs were present during design. This design is based on the proposal, exploration, and the inspected local/upstream code.

## Architecture Decisions

### Decision: Keep the local shell and identity

| Option                                                                    | Tradeoff                                                                               | Decision |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------- |
| Copy upstream `src/tui.tsx` wholesale                                     | Fastest parity, but reintroduces keyboard/focus behavior and upstream package identity | Reject   |
| Keep local `index.tsx` + `src/tui.tsx` shell, port only pure core helpers | More adaptation work, but preserves `mrjmpl3-*` naming and mouse UX                    | Accept   |

Rationale: the change intent is sync-without-keyboard, not replace-the-plugin.

### Decision: Merge event-driven synthetic rows with snapshot-driven real sessions

| Option                                                                                                                       | Tradeoff                                                                           | Decision |
| ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------- |
| Continue refresh-only logic                                                                                                  | Simple, but loses upstream subtask/tool evidence and duplicate-collapse inputs     | Reject   |
| Fully event-driven like upstream                                                                                             | Broad refactor and larger review slices                                            | Reject   |
| Keep `session.children()` as authority for real sessions, but enrich state with upstream event parsing for subtask/tool rows | Slightly more orchestration, but fits local architecture and adds missing fidelity | Accept   |

Rationale: this preserves the current refresh loop while enabling upstream bug fixes that depend on tool/subtask evidence.

### Decision: Port pure render/state helpers, not keyboard helpers

| Option                                                                         | Tradeoff                                                               | Decision |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | -------- |
| Leave render logic inline in `src/tui.tsx`                                     | Smaller initial diff, but keeps dedup/visibility logic hard to test    | Reject   |
| Add local `src/render.ts` and port upstream collapse/visibility/status helpers | New file, but isolates the highest-risk behavior in unit-testable code | Accept   |

Rationale: duplicate collapse, recent-done visibility, and status text rendering are the main upstream UX gains and do not require keyboard support.

## Data Flow

```text
OpenCode events ──→ events.applySubagentEvent() ──→ state mutations
      │                                              │
      └──── refresh trigger ─────────────────────────┤
                                                     ↓
api.client.session.children()/status/messages ─→ reconcile + maintenance
                                                     ↓
                              render.visibleSubagentWorkItems()/renderStatusLine()
                                                     ↓
                           sidebar rows + home summary + persisted status.txt
```

## File Changes

| File                                                                                                           | Action | Description                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tui-plugins/mrjmpl3-subagent-status/src/types.ts`                                                             | Modify | Extend the local child contract with upstream-derived render/state fields (`color`, `elapsedMs`) while keeping local names.                                |
| `tui-plugins/mrjmpl3-subagent-status/src/events.ts`                                                            | Modify | Keep the lifecycle bridge, but add upstream-style event parsing and `applySubagentEvent()` for session, subtask, and task-tool evidence.                   |
| `tui-plugins/mrjmpl3-subagent-status/src/reconcile.ts`                                                         | Modify | Change snapshot reconcile to upsert authoritative session rows without deleting synthetic rows; port status/message summarizers needed by maintenance.     |
| `tui-plugins/mrjmpl3-subagent-status/src/state.ts`                                                             | Modify | Port counter rekeying, detail upserts, derived fields, and persisted-state normalization while keeping `MRJMPL3_*` env names and local retention defaults. |
| `tui-plugins/mrjmpl3-subagent-status/src/logs.ts`                                                              | Modify | Reuse local log hydration and add upstream-compatible token extraction paths needed by the new event/state flow.                                           |
| `tui-plugins/mrjmpl3-subagent-status/src/render.ts`                                                            | Create | Hold pure formatting, dedup, recent-visibility, and statusline helpers adapted from upstream.                                                              |
| `tui-plugins/mrjmpl3-subagent-status/src/tui.tsx`                                                              | Modify | Orchestrate event application, snapshot maintenance, mouse-only rendering, and persisted status text using the new helpers.                                |
| `tui-plugins/mrjmpl3-subagent-status/src/events.test.ts`                                                       | Create | Cover event parsing, task-tool mapping, and fail-closed ambiguity cases.                                                                                   |
| `tui-plugins/mrjmpl3-subagent-status/src/render.test.ts`                                                       | Create | Cover duplicate collapse, visibility filtering, and compact context rendering.                                                                             |
| `tui-plugins/mrjmpl3-subagent-status/src/reconcile.test.ts` / `state.test.ts` / `logs.test.ts` / `tui.test.ts` | Modify | Update package-local coverage for merged state flow and mouse-only behavior.                                                                               |

## Interfaces / Contracts

```ts
export interface SubagentChild {
  id: string;
  source?: 'session' | 'subtask' | 'tool';
  targetSessionID?: string;
  status: 'running' | 'done' | 'error';
  color?: 'yellow' | 'green' | 'red';
  elapsedMs?: number;
  tokens?: { input?: number; output?: number; total?: number; contextPercent?: number };
}

export function applySubagentEvent(state: SubagentState, event: unknown): boolean;
export function visibleSubagentWorkItems(children: SubagentChild[], nowMs?: number): SubagentChild[];
```

## Testing Strategy

| Layer       | What to Test                                                        | Approach                                                                           |
| ----------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Unit        | Event parsing, counter rekeying, dedup, visibility, token hydration | Add/update Vitest module tests in `src/*.test.ts`.                                 |
| Integration | `src/tui.tsx` orchestration of event + snapshot + mouse navigation  | Keep package-local mocked `TuiPluginApi` tests in Vitest; no new external harness. |
| E2E         | Not planned                                                         | No E2E suite exists in this repo.                                                  |

## Migration / Rollout

No migration required. Roll out in chained review slices: (1) state/reconcile core, (2) render + tests, (3) `tui.tsx` integration. This change is likely over the 400-line budget if delivered as one PR.

## Open Questions

- [ ] None.
