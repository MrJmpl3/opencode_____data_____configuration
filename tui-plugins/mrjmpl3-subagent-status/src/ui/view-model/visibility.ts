import type { SubagentChild } from '../../domain/types.ts';

import { DEFAULT_SUBAGENT_VISIBILITY_POLICY, type SubagentVisibilityPolicy } from '../../shared/visibility.ts';
import { collapseSubagentWorkItems } from './collapse.ts';

export interface SidebarVisibleSections {
  active: SubagentChild[];
  zombies: SubagentChild[];
  recent: SubagentChild[];
}

export const isVisibleWorkItem = (
  child: SubagentChild,
  nowMs = Date.now(),
  visibilityPolicy: SubagentVisibilityPolicy = DEFAULT_SUBAGENT_VISIBILITY_POLICY,
): boolean => {
  if (child.status === 'running' || child.status === 'error') return true;

  const endedMs = Date.parse(child.endedAt ?? child.updatedAt);
  if (Number.isNaN(endedMs)) return false;

  if (child.status === 'stale') return nowMs - endedMs <= visibilityPolicy.staleRetentionMs;

  return nowMs - endedMs <= visibilityPolicy.doneRetentionMs;
};

export const visibleSubagentWorkItems = (
  children: SubagentChild[],
  nowMs = Date.now(),
  visibilityPolicy: SubagentVisibilityPolicy = DEFAULT_SUBAGENT_VISIBILITY_POLICY,
): SubagentChild[] => {
  const visible = collapseSubagentWorkItems(children).filter((child) =>
    isVisibleWorkItem(child, nowMs, visibilityPolicy),
  );
  const hasRunning = visible.some((child) => child.status === 'running');
  const activeMessageIDs = new Set(
    visible.flatMap((child) => (child.status === 'running' && child.messageID ? [child.messageID] : [])),
  );

  if (!hasRunning) return visible;

  return visible.filter((child) => {
    if (child.status === 'running' || child.status === 'error' || child.status === 'stale') return true;
    if (!child.messageID) return false;
    return activeMessageIDs.has(child.messageID);
  });
};

export const splitSidebarVisibleSections = (children: readonly SubagentChild[]): SidebarVisibleSections =>
  children.reduce<SidebarVisibleSections>(
    (sections, child) => {
      if (child.status === 'running') {
        sections.active.push(child);
      } else if (child.status === 'stale') {
        sections.zombies.push(child);
      } else {
        sections.recent.push(child);
      }

      return sections;
    },
    { active: [], zombies: [], recent: [] },
  );
