import type { SubagentChild, SubagentState } from './types.ts';

const RECENT_DONE_VISIBLE_MS = 10 * 60 * 1000;

export function formatDuration(elapsedMs: number | undefined): string {
  const totalSeconds = Math.max(0, Math.floor((elapsedMs ?? 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatNumber(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString('en-US');
}

function resolveTokenTotal(child: SubagentChild): number | undefined {
  const total = child.tokens?.total;
  if (typeof total === 'number' && Number.isFinite(total)) {
    return total;
  }

  const input = child.tokens?.input;
  const output = child.tokens?.output;
  if (typeof input === 'number' || typeof output === 'number') {
    return (input ?? 0) + (output ?? 0);
  }

  return undefined;
}

function formatCompactTokenCount(total: number): string {
  const value = Math.max(0, total);
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M ctx`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k ctx`;
  return `${Math.round(value)} ctx`;
}

function formatCompactPercentUsed(percent: number): string {
  return `${Math.max(0, Math.round(percent))}%`;
}

export function formatContextCompact(child: SubagentChild): string {
  const total = resolveTokenTotal(child);
  const percent = child.tokens?.contextPercent;

  const hasTotal = typeof total === 'number' && Number.isFinite(total);
  const hasPercent = typeof percent === 'number' && Number.isFinite(percent);

  if (hasTotal && hasPercent) {
    return `${formatCompactTokenCount(total)} ${formatCompactPercentUsed(percent)}`;
  }

  if (hasTotal) return formatCompactTokenCount(total);
  if (hasPercent) return formatCompactPercentUsed(percent);
  return '';
}

export function statusColor(status: SubagentChild['status']): NonNullable<SubagentChild['color']> {
  if (status === 'done') return 'green';
  if (status === 'error') return 'red';
  return 'yellow';
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
  const hiddenTargetSessionIDs = new Set<string>();
  const hiddenMessageKeys = new Set<string>();

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

      if (child.targetSessionID) hiddenTargetSessionIDs.add(child.targetSessionID);
      if (child.messageID) hiddenMessageKeys.add(messageKey(child.parentID, child.messageID));
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
      if (candidate.source === 'session') hiddenMatchedSessionIDs.add(candidate.id);
    }

    if (bestSession) {
      sessionBySyntheticID.set(synthetic.id, bestSession);
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
        return !(
          hiddenTargetSessionIDs.has(child.id) ||
          (child.messageID && hiddenMessageKeys.has(messageKey(child.parentID, child.messageID))) ||
          hiddenMatchedSessionIDs.has(child.id)
        );
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

export function renderStatusLine(state: SubagentState, nowMs = Date.now()): string {
  const children = visibleSubagentWorkItems(Object.values(state.children), nowMs).sort(byPriority);
  const running = children.filter((child) => child.status === 'running').length;
  const done = children.filter((child) => child.status === 'done').length;
  const error = children.filter((child) => child.status === 'error').length;
  const aggregate = `Subagents: ${running} run · ${done} done · ${error} err · Σ ${formatNumber(state.totalExecuted)}`;

  if (children.length === 0) return aggregate;

  const details = children
    .map((child) => {
      const context = formatContextCompact(child);
      return [child.title, formatDuration(child.elapsedMs), context].filter((part) => part.length > 0).join(' ');
    })
    .join(' · ');

  return `${aggregate} · ${details}`;
}
