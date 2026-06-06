import type { SubagentChild } from '../../domain/types.ts';

import { collapseSubagentWorkItems } from './collapse.ts';

const RECENT_DONE_VISIBLE_MS = 10 * 60 * 1000;

export interface SidebarVisibleSections {
  active: SubagentChild[];
  recent: SubagentChild[];
}

export const isVisibleWorkItem = (child: SubagentChild, nowMs = Date.now()): boolean => {
  if (child.status !== 'done') return true;
  const endedMs = Date.parse(child.endedAt ?? child.updatedAt);
  if (Number.isNaN(endedMs)) return false;
  return nowMs - endedMs <= RECENT_DONE_VISIBLE_MS;
};

export const visibleSubagentWorkItems = (children: SubagentChild[], nowMs = Date.now()): SubagentChild[] => {
  const visible = collapseSubagentWorkItems(children).filter((child) => isVisibleWorkItem(child, nowMs));
  const hasRunning = visible.some((child) => child.status === 'running');
  const activeMessageIDs = new Set(
    visible.filter((child) => child.status === 'running' && child.messageID).map((child) => child.messageID as string),
  );

  if (!hasRunning) return visible;

  return visible.filter((child) => {
    if (child.status === 'running' || child.status === 'error') return true;
    if (!child.messageID) return false;
    return activeMessageIDs.has(child.messageID);
  });
};

export const splitSidebarVisibleSections = (children: readonly SubagentChild[]): SidebarVisibleSections =>
  children.reduce<SidebarVisibleSections>(
    (sections, child) => {
      if (child.status === 'running') {
        sections.active.push(child);
      } else {
        sections.recent.push(child);
      }

      return sections;
    },
    { active: [], recent: [] },
  );
