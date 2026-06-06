import type { SubagentChild, SubagentCounts, SubagentState } from '../domain/types.ts';

import { formatDuration, formatUsageCompact, statusColor } from './format.ts';

const RECENT_DONE_VISIBLE_MS = 10 * 60 * 1000;

function formatNumber(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString('en-US');
}

export function byPriority(left: SubagentChild, right: SubagentChild): number {
  const startedDiff = right.startedAt.localeCompare(left.startedAt);
  if (startedDiff !== 0) return startedDiff;

  return left.id.localeCompare(right.id);
}

function normalizeWorkItemTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function relatedWorkItemTitles(left: string, right: string): boolean {
  const normalizedLeft = normalizeWorkItemTitle(left);
  const normalizedRight = normalizeWorkItemTitle(right);
  if (!normalizedLeft || !normalizedRight) return false;

  return normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft);
}

function sameAgentName(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return true;
  return normalizeWorkItemTitle(left) === normalizeWorkItemTitle(right);
}

function isGenericToolWrapper(child: SubagentChild): boolean {
  if (child.source !== 'tool') return false;
  const title = normalizeWorkItemTitle(child.title);
  return title === 'delegate' || title === 'task';
}

function sessionMatchesSynthetic(session: SubagentChild, synthetic: SubagentChild): boolean {
  if (session.source !== 'session' && !session.id.startsWith('ses_')) return false;
  if (session.parentID !== synthetic.parentID) return false;
  if (synthetic.targetSessionID === session.id) return true;
  if (session.targetSessionID === synthetic.id) return true;
  if (synthetic.messageID && session.messageID && synthetic.messageID === session.messageID) {
    return true;
  }
  if (isGenericToolWrapper(synthetic)) return false;

  return sameAgentName(session.agentName, synthetic.agentName) && relatedWorkItemTitles(session.title, synthetic.title);
}

function messageKey(parentID: string, messageID: string): string {
  return `${parentID}\0${messageID}`;
}

function betterPriority(current: SubagentChild | undefined, candidate: SubagentChild): SubagentChild {
  if (!current) return candidate;
  return byPriority(candidate, current) < 0 ? candidate : current;
}

function mergeSyntheticWithSession(synthetic: SubagentChild, session: SubagentChild | undefined): SubagentChild {
  if (!session) return synthetic;

  return {
    ...synthetic,
    status: session.status,
    color: session.color,
    startedAt: session.startedAt ?? synthetic.startedAt,
    updatedAt: session.updatedAt ?? synthetic.updatedAt,
    endedAt: session.endedAt ?? synthetic.endedAt,
    elapsedMs: session.elapsedMs ?? synthetic.elapsedMs,
    tokens: session.tokens ?? synthetic.tokens,
    targetSessionID: session.id,
    agentName: synthetic.agentName ?? session.agentName,
  };
}

export function collapseSubagentWorkItems(children: SubagentChild[]): SubagentChild[] {
  const syntheticChildren: SubagentChild[] = [];
  const syntheticByParentID = new Map<string, SubagentChild[]>();
  const sessionCandidatesByParentID = new Map<string, SubagentChild[]>();

  for (const child of children) {
    const isSynthetic = child.source === 'tool' || child.source === 'subtask';
    if (isSynthetic) {
      syntheticChildren.push(child);
      const siblings = syntheticByParentID.get(child.parentID);
      if (siblings) {
        siblings.push(child);
      } else {
        syntheticByParentID.set(child.parentID, [child]);
      }
    }

    if (child.source === 'session' || child.id.startsWith('ses_')) {
      const candidates = sessionCandidatesByParentID.get(child.parentID);
      if (candidates) {
        candidates.push(child);
      } else {
        sessionCandidatesByParentID.set(child.parentID, [child]);
      }
    }
  }

  const sessionBySyntheticID = new Map<string, SubagentChild>();
  const hiddenMatchedSessionIDs = new Set<string>();
  const hiddenSyntheticToolIDs = new Set<string>();

  for (const synthetic of syntheticChildren) {
    let bestSession: SubagentChild | undefined;
    const sessionCandidates = sessionCandidatesByParentID.get(synthetic.parentID) ?? [];
    for (const candidate of sessionCandidates) {
      if (!sessionMatchesSynthetic(candidate, synthetic)) continue;

      bestSession = betterPriority(bestSession, candidate);
    }

    if (bestSession) {
      sessionBySyntheticID.set(synthetic.id, bestSession);
      if (bestSession.source === 'session') hiddenMatchedSessionIDs.add(bestSession.id);
    }
  }

  for (const siblings of syntheticByParentID.values()) {
    for (const child of siblings) {
      if (child.source !== 'tool') continue;

      if (isGenericToolWrapper(child)) {
        if (siblings.length > 1) hiddenSyntheticToolIDs.add(child.id);
        continue;
      }

      for (const sibling of siblings) {
        if (sibling.id === child.id) continue;
        if (relatedWorkItemTitles(sibling.title, child.title)) {
          hiddenSyntheticToolIDs.add(child.id);
          break;
        }
      }
    }
  }

  return children
    .filter((child) => {
      if (child.source === 'session') {
        return !hiddenMatchedSessionIDs.has(child.id);
      }

      if (child.source !== 'tool') return true;
      return !hiddenSyntheticToolIDs.has(child.id);
    })
    .map((child) => mergeSyntheticWithSession(child, sessionBySyntheticID.get(child.id)));
}

export function isVisibleWorkItem(child: SubagentChild, nowMs = Date.now()): boolean {
  if (child.status !== 'done') return true;
  const endedMs = Date.parse(child.endedAt ?? child.updatedAt);
  if (Number.isNaN(endedMs)) return false;
  return nowMs - endedMs <= RECENT_DONE_VISIBLE_MS;
}

export function visibleSubagentWorkItems(children: SubagentChild[], nowMs = Date.now()): SubagentChild[] {
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
}

function countsFromChildren(children: readonly SubagentChild[]): SubagentCounts {
  return children.reduce<SubagentCounts>(
    (counts, child) => {
      counts[child.status] += 1;
      return counts;
    },
    { running: 0, done: 0, error: 0 },
  );
}

function resolveElapsedMs(
  child: Pick<SubagentChild, 'startedAt' | 'updatedAt' | 'endedAt' | 'status'>,
  nowMs: number,
): number {
  const startedMs = Date.parse(child.startedAt);
  if (Number.isNaN(startedMs)) return 0;

  const endMs = child.status === 'running' ? nowMs : Date.parse(child.endedAt ?? child.updatedAt);
  if (Number.isNaN(endMs)) return 0;

  return Math.max(0, endMs - startedMs);
}

function hydrateSnapshotChild(child: SubagentChild, nowMs: number): SubagentChild {
  return {
    ...child,
    elapsedMs: resolveElapsedMs(child, nowMs),
  };
}

export interface SubagentSnapshotView {
  trackedChildren: SubagentChild[];
  visibleChildren: SubagentChild[];
  trackedCounts: SubagentCounts;
  visibleCounts: SubagentCounts;
}

export interface SidebarVisibleSections {
  active: SubagentChild[];
  recent: SubagentChild[];
}

export function splitSidebarVisibleSections(children: readonly SubagentChild[]): SidebarVisibleSections {
  return children.reduce<SidebarVisibleSections>(
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
}

export function buildSubagentSnapshotView(
  children: readonly SubagentChild[],
  nowMs = Date.now(),
): SubagentSnapshotView {
  const hydratedChildren = [...children].map((child) => hydrateSnapshotChild(child, nowMs)).sort(byPriority);
  const trackedChildren = collapseSubagentWorkItems(hydratedChildren).sort(byPriority);
  const visibleChildren = visibleSubagentWorkItems(hydratedChildren, nowMs).sort(byPriority);

  return {
    trackedChildren,
    visibleChildren,
    trackedCounts: countsFromChildren(trackedChildren),
    visibleCounts: countsFromChildren(visibleChildren),
  };
}

function renderAggregate(counts: SubagentCounts): string {
  return `Subagents: ${counts.running} run · ${counts.done} done · ${counts.error} err`;
}

function renderSnapshotAggregate(counts: SubagentCounts): string {
  return renderAggregate(counts).replace(/^Subagents: /, 'Subagents snapshot: ');
}

function renderStatusDetails(children: readonly SubagentChild[]): string {
  if (children.length === 0) return '';

  return children
    .map((child) => {
      const usage = formatUsageCompact(child);
      return [child.title, formatDuration(child.elapsedMs), usage].filter((part) => part.length > 0).join(' ');
    })
    .join(' · ');
}

export function renderStatusLine(state: SubagentState, nowMs = Date.now()): string {
  const view = buildSubagentSnapshotView(Object.values(state.children), nowMs);
  const aggregate = `${renderAggregate(view.trackedCounts)} · Σ ${formatNumber(state.totalExecuted)}`;
  const details = renderStatusDetails(view.visibleChildren);

  return details.length > 0 ? `${aggregate} · ${details}` : aggregate;
}

export function renderStatusSnapshotLine(state: SubagentState, nowMs = Date.now()): string {
  const view = buildSubagentSnapshotView(Object.values(state.children), nowMs);
  const aggregate = `${renderSnapshotAggregate(view.trackedCounts)} · Σ ${formatNumber(state.totalExecuted)}`;
  const details = renderStatusDetails(view.visibleChildren);

  return details.length > 0 ? `${aggregate} · ${details}` : aggregate;
}

export { statusColor };
