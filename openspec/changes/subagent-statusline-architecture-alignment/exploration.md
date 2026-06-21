# status

ready for proposal

# executive_summary

`mrjmpl3-quota` has a clean split between package surface, runtime orchestration, and provider
adapters. `mrjmpl3-subagent-status` is functionally stronger but structurally denser: one `src/`
tree mixes TUI orchestration, state/reconcile logic, recovery, persistence, rendering, session
routing, and logs. The best alignment path is to separate orchestration from domain/infrastructure
helpers without copying quota’s provider model where the domain does not fit.

# artifacts

- `openspec/changes/subagent-statusline-architecture-alignment/exploration.md`
- Reference package inspected at `tui-plugins/mrjmpl3-quota/`
- Target package inspected at `tui-plugins/mrjmpl3-subagent-status/`

# next_recommended

Propose a narrow-to-medium reorganization focused on package surface, runtime boundaries, and test
placement. Keep the current subagent-specific recovery/persistence behavior intact.

# risks

- A literal folder-by-folder copy of the quota plugin would introduce fake symmetry and hide the
  real subagent domain boundaries.
- Moving many files at once could make the next review slice too large.
- The current subagent module graph is tightly coupled; boundary extraction must preserve
  execution-count and recovery semantics.

# skill_resolution

paths-injected — 5 skills (software-engineer, typescript-expert, architecture-patterns,
cognitive-doc-design, sdd-explore)

# architecture_findings

## current_state

- `mrjmpl3-quota` uses a flat package shell: root `index.tsx`, `providers.ts`, `runtime/`,
  `providers/`, and a single `test/` directory.
- `mrjmpl3-subagent-status` uses a single `src/` tree plus a root `index.tsx`; most logic lives
  under `src/` as colocated modules and tests.
- Quota separates provider adapters (`providers/`) from orchestration/UI (`runtime/`), while
  subagent mixes runtime, persistence, recovery, rendering, state, and session routing in one
  namespace.
- Quota’s public surface is intentionally small and explicit; subagent’s root surface is thinner,
  but the internal module graph is much denser.

## affected_areas

- `tui-plugins/mrjmpl3-subagent-status/index.tsx` — should become the clear package entrypoint, like
  quota’s root export.
- `tui-plugins/mrjmpl3-subagent-status/src/tui.tsx` — currently contains both registration and
  rendering concerns.
- `tui-plugins/mrjmpl3-subagent-status/src/refresh.ts` — orchestrates event intake, recovery
  hydration, persistence, and session transitions.
- `tui-plugins/mrjmpl3-subagent-status/src/state.ts` — holds the densest domain logic and likely
  deserves its own core boundary.
- `tui-plugins/mrjmpl3-subagent-status/src/recovery.ts` and `src/recovery/sqlite.ts` —
  infrastructure boundary that should remain separate from pure state logic.
- `tui-plugins/mrjmpl3-subagent-status/src/render.ts`, `src/snapshot.ts`, `src/logs.ts`,
  `src/session.ts` — supporting helpers that can be grouped by responsibility.
- `tui-plugins/mrjmpl3-quota/runtime/*` and `providers/*` — reference shape for a cleaner
  runtime/adapters split.
- `tui-plugins/mrjmpl3-quota/test/plugin.test.ts` vs.
  `tui-plugins/mrjmpl3-subagent-status/src/*.test.ts` — contrasting test layout strategies.

## approaches

1. **Quota-like package shell with subagent-aware internals** — keep the subagent domain, but split
   the package into a small root entrypoint, a runtime/orchestration layer, and focused helper
   folders.
   - Pros: aligns package ergonomics with quota; makes entrypoints and boundaries obvious; limits
     churn to structure, not behavior.
   - Cons: requires file moves and import updates; some modules are still highly interdependent.
   - Effort: Medium

2. **Minimal boundary cleanup only** — keep `src/` intact and only extract a thin root API plus a
   few obvious subfolders (for example `runtime/` and `core/`).
   - Pros: lowest risk; smallest diff; preserves current test locality.
   - Cons: weaker alignment with quota; dense `src/` remains a catch-all.
   - Effort: Low

3. **Full mirrored restructure** — force the subagent plugin into the same folder taxonomy as quota,
   including a provider-like split.
   - Pros: maximum visual symmetry.
   - Cons: artificial mapping; no real domain fit; likely to overcomplicate recovery and persistence
     boundaries.
   - Effort: High

## recommendation

Choose option 1, but only for the boundaries that are actually meaningful here. The statusline
plugin should look and feel like the quota plugin at the package level (clear root entrypoint,
explicit runtime layer, helper/adapters separation), while keeping recovery, persistence, and
reconciliation as first-class subagent-specific concerns.

## what_should_stay_as_is

- Mouse-only TUI behavior and session navigation affordances.
- Subagent-specific recovery sources (SQLite/log/session state) and persistence mechanics.
- The richer state machine around terminal preservation, purged sessions, and execution counting.
- Colocated tests for very local pure helpers when they improve readability.

## ready_for_proposal

Yes — tell the user the next step is a proposal focused on structural alignment, not behavior
changes.
