import type { SubagentChild, SubagentCounts, SubagentState } from '../domain/types.ts';

import { statusColor as resolveRenderStatusColor } from '../ui/format.ts';
import { buildSubagentSnapshotView, renderStatusLine, renderStatusSnapshotLine } from '../ui/view-model.ts';

export interface TuiSnapshot {
  counts: SubagentCounts;
  visibleCounts: SubagentCounts;
  statusLine: string;
  statusSnapshotLine: string;
  visibleChildren: SubagentChild[];
  debug: {
    snapshotSemantics: 'snapshot';
    trackedChildren: number;
    visibleChildren: number;
    hiddenChildren: number;
    trackedCounts: SubagentCounts;
    visibleCounts: SubagentCounts;
  };
}

export function elapsedMs(child: SubagentChild, now: number): number {
  const startedAt = Date.parse(child.startedAt);
  if (Number.isNaN(startedAt)) return 0;

  if (child.status === 'running') {
    return Math.max(0, now - startedAt);
  }

  const endedAt = Date.parse(child.endedAt ?? child.updatedAt);
  if (Number.isNaN(endedAt)) return 0;
  return Math.max(0, endedAt - startedAt);
}

function hydrateSnapshotChild(child: SubagentChild, nowMs: number): SubagentChild {
  return {
    ...child,
    color: child.color ?? resolveRenderStatusColor(child.status),
    elapsedMs: elapsedMs(child, nowMs),
  };
}

export function buildTuiSnapshot(state: SubagentState, nowMs = Date.now()): TuiSnapshot {
  const hydratedChildren = Object.values(state.children).map((child) => hydrateSnapshotChild(child, nowMs));
  const snapshotView = buildSubagentSnapshotView(hydratedChildren, nowMs);

  return {
    counts: snapshotView.trackedCounts,
    visibleCounts: snapshotView.visibleCounts,
    statusLine: renderStatusLine(state, nowMs),
    statusSnapshotLine: renderStatusSnapshotLine(state, nowMs),
    visibleChildren: snapshotView.visibleChildren,
    debug: {
      snapshotSemantics: 'snapshot',
      trackedChildren: snapshotView.trackedChildren.length,
      visibleChildren: snapshotView.visibleChildren.length,
      hiddenChildren: Math.max(0, snapshotView.trackedChildren.length - snapshotView.visibleChildren.length),
      trackedCounts: snapshotView.trackedCounts,
      visibleCounts: snapshotView.visibleCounts,
    },
  };
}
