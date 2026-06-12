import type { SubagentChild, SubagentCounts, SubagentState } from '../../domain/types.ts';

import { DEFAULT_SUBAGENT_VISIBILITY_POLICY, type SubagentVisibilityPolicy } from '../../shared/visibility.ts';
import { formatDuration, formatUsageCompact } from '../format.ts';

import { buildSubagentSnapshotView } from './snapshot-view.ts';
import { formatAggregateNumber } from './sort.ts';

const renderAggregate = (counts: SubagentCounts): string =>
  `Subagents: ${counts.running} run · ${counts.done} done · ${counts.error + counts.stale} err`;

const renderSnapshotAggregate = (counts: SubagentCounts): string =>
  renderAggregate(counts).replace(/^Subagents: /, 'Subagents snapshot: ');

const renderStatusDetails = (children: readonly SubagentChild[]): string => {
  if (children.length === 0) return '';

  return children
    .map((child) => {
      const usage = formatUsageCompact(child);
      return [child.title, formatDuration(child.elapsedMs), usage].filter((part) => part.length > 0).join(' ');
    })
    .join(' · ');
};

export const renderStatusLine = (
  state: SubagentState,
  nowMs = Date.now(),
  visibilityPolicy: SubagentVisibilityPolicy = DEFAULT_SUBAGENT_VISIBILITY_POLICY,
): string => {
  const view = buildSubagentSnapshotView(Object.values(state.children), nowMs, visibilityPolicy);
  const aggregate = `${renderAggregate(view.trackedCounts)} · Σ ${formatAggregateNumber(state.totalExecuted)}`;
  const details = renderStatusDetails(view.visibleChildren);

  return details.length > 0 ? `${aggregate} · ${details}` : aggregate;
};

export const renderStatusSnapshotLine = (
  state: SubagentState,
  nowMs = Date.now(),
  visibilityPolicy: SubagentVisibilityPolicy = DEFAULT_SUBAGENT_VISIBILITY_POLICY,
): string => {
  const view = buildSubagentSnapshotView(Object.values(state.children), nowMs, visibilityPolicy);
  const aggregate = `${renderSnapshotAggregate(view.trackedCounts)} · Σ ${formatAggregateNumber(state.totalExecuted)}`;
  const details = renderStatusDetails(view.visibleChildren);

  return details.length > 0 ? `${aggregate} · ${details}` : aggregate;
};
