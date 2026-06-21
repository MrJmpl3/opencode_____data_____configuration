# status

ready for proposal

# executive_summary

The local plugin is already close to upstream, but there are real gaps in terminal-state
preservation, task/subtask completion handling, delegation counting, and stale-row retention. The
safest next step is a selective parity pass that keeps the TUI mouse-only and does not copy the
keyboard/focus layer.

# artifacts

- `openspec/changes/subagent-statusline-improvements/exploration.md`
- Reference repo inspected at `/tmp/opencode/sub-agent-statusline/src`

# next_recommended

Propose a medium-scope, non-keyboard change focused on state/event/reconcile parity, token recovery
improvements, and tests for the edge cases below.

# risks

- Copying the upstream keyboard/focus layer would violate the local mouse-only constraint.
- A full parity rewrite is likely too large for a single review slice.
- Direct SQLite shell access (used upstream) is portable-risky in this workspace.

# skill_resolution

sdd-explore completed; no rename needed.

# comparison_findings

## features

- Upstream improves completion propagation: task-tool and subtask rows can be terminalized from
  completed evidence; local keeps task evidence effectively running until session updates arrive.
- Upstream is stricter about stale-row lifecycle and preserves terminal state/timing more safely;
  local prunes more aggressively and has less protective state transitions.
- Upstream adds SQLite-backed token recovery; local only hydrates tokens from log files.
- Upstream’s event parsing and child-detail extraction are broader (more title/agent fallbacks and
  status shapes).

## bugfixes

- Local `upsertRunningChild` can regress a terminal row back to running if newer running data
  arrives; upstream preserves completed/error timing.
- Local counts technical delegation rows toward `totalExecuted`; upstream explicitly excludes
  delegation-style titles.
- Local does not terminalize task/subtask rows from completed tool evidence, so some rows can linger
  longer than necessary.

## architecture

- Local is already modular enough; the useful upstream lesson is tighter terminal-preserving
  reconciliation, not the keyboard layer.
- Keep the current TUI entrypoint and mouse-only UX; port pure helpers/state semantics instead.
- If expanded, the next abstraction boundary should be event normalization + state transitions, not
  focus management.

## tests

- Missing coverage for terminal-to-running regressions.
- Missing coverage for delegation-title exclusion from execution counts.
- Missing coverage for task completion propagating to subtask/session rows.
- Missing coverage for SQLite-based token recovery and stale-row retention limits.

## non-goals

- Keyboard shortcuts, focus restoration, global registries, and command-palette wiring.
- ANSI/statusline text rendering changes that assume a CLI-only plugin model.
- Broad architectural rewrite just to match upstream file layout.

# recommended_change_scope

medium — the important fixes are related and mostly local to event/state/reconcile/token helpers,
but they still need careful tests and a guarded rollout.

# suggested_change_name

subagent-statusline-improvements
