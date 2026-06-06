import type { SubagentChild, SubagentState, SubagentTokens } from '../types.ts';

import { createEmptyState } from './core.ts';
import { isTerminalStatus } from './helpers.ts';
import {
  childEvidenceTimestampMs,
  mergeTokens,
  safeTimestamp,
  sameTokens,
  sanitizeAgentName,
  sanitizeSummary,
  sanitizeTargetSessionID,
  timestampMs,
  toNonNegativeInteger,
} from './helpers.ts';
import { normalizeChild } from './normalization.ts';
import { pruneTerminalChildren } from './pruning.ts';
import { clearPurgedSession, resolveSessionIdentity } from './session-identity.ts';
import { rekeyCountedExecution, resolveExecutionCountIdentity, syncExecutionState } from './execution-count.ts';
import { isSubtaskFallback } from './child-kind.ts';

const countChildExecution = (
  state: SubagentState,
  child: Pick<SubagentChild, 'id' | 'title' | 'parentID'> &
    Partial<Pick<SubagentChild, 'messageID' | 'source' | 'targetSessionID'>>,
): boolean => {
  state.totalExecuted = Math.max(
    toNonNegativeInteger(state.totalExecuted) ?? 0,
    Object.keys(state.countedChildIDs).length,
  );
  const countIdentity = resolveExecutionCountIdentity(state, child);
  if (!countIdentity || state.countedChildIDs[countIdentity]) return false;

  state.countedChildIDs[countIdentity] = true;
  state.totalExecuted = Math.max(
    toNonNegativeInteger(state.totalExecuted) ?? 0,
    Object.keys(state.countedChildIDs).length,
  );
  return true;
};

const reconcileSubtaskTargetCount = (
  state: SubagentState,
  child: Pick<SubagentChild, 'id'> & Partial<Pick<SubagentChild, 'source' | 'targetSessionID'>>,
): boolean => {
  if (!isSubtaskFallback(child) || !child.targetSessionID) return false;
  return rekeyCountedExecution(state, child.id, child.targetSessionID);
};

export const upsertRunningChild = (
  state: SubagentState,
  input: Pick<SubagentChild, 'id' | 'title' | 'parentID'> &
    Partial<
      Pick<
        SubagentChild,
        | 'summary'
        | 'agentName'
        | 'messageID'
        | 'source'
        | 'targetSessionID'
        | 'startedAt'
        | 'updatedAt'
        | 'status'
        | 'endedAt'
      >
    >,
  options: { allowPurgedSessionRestore?: boolean; allowTerminalReopen?: boolean } = {},
): boolean => {
  const now = new Date().toISOString();
  const existing = state.children[input.id];
  const source = input.source ?? existing?.source ?? (input.id.startsWith('ses_') ? 'session' : undefined);
  const observedUpdatedAt = safeTimestamp(input.updatedAt, now);
  const observedStartedAt = safeTimestamp(input.startedAt, existing?.startedAt ?? observedUpdatedAt);
  const targetSessionID = sanitizeTargetSessionID(
    input.targetSessionID ?? existing?.targetSessionID,
    input.id.startsWith('ses_') ? input.id : undefined,
  );
  const incomingStatus =
    input.status === 'done' || input.status === 'error' || input.status === 'running'
      ? input.status
      : (existing?.status ?? 'running');
  const sessionIdentity = resolveSessionIdentity({ id: input.id, targetSessionID });
  if (!existing && sessionIdentity && state.purgedSessionIDs[sessionIdentity] && !options.allowPurgedSessionRestore) {
    return false;
  }

  if (sessionIdentity && options.allowPurgedSessionRestore) {
    clearPurgedSession(state, sessionIdentity);
  }

  const existingEvidenceMs = existing ? childEvidenceTimestampMs(existing) : 0;
  const incomingEvidenceMs = timestampMs(input.endedAt ?? observedUpdatedAt ?? observedStartedAt);
  const staleEvidence = Boolean(existing && incomingEvidenceMs < existingEvidenceMs);
  const reopenTerminal = Boolean(
    existing &&
      isTerminalStatus(existing.status) &&
      incomingStatus === 'running' &&
      options.allowTerminalReopen === true &&
      incomingEvidenceMs > existingEvidenceMs,
  );
  const preserveExistingTiming = Boolean(
    existing &&
      (staleEvidence || (isTerminalStatus(existing.status) && incomingStatus === 'running' && !reopenTerminal)),
  );
  const status = preserveExistingTiming ? existing!.status : incomingStatus;
  const nextUpdatedAt = preserveExistingTiming ? existing!.updatedAt : observedUpdatedAt;
  const nextEndedAt = preserveExistingTiming
    ? existing!.endedAt
    : status === 'running'
      ? undefined
      : (input.endedAt ?? existing?.endedAt ?? observedUpdatedAt);

  const counted = existing
    ? false
    : countChildExecution(state, {
        id: input.id,
        title: input.title,
        parentID: input.parentID,
        messageID: input.messageID,
        source,
        targetSessionID,
      });

  const next = normalizeChild({
    id: input.id,
    title: input.title,
    summary: input.summary ?? existing?.summary,
    agentName: input.agentName ?? existing?.agentName,
    parentID: input.parentID,
    messageID: input.messageID ?? existing?.messageID,
    source,
    targetSessionID,
    status,
    startedAt: observedStartedAt,
    updatedAt: nextUpdatedAt,
    endedAt: nextEndedAt,
    color: existing?.color,
    elapsedMs: existing?.elapsedMs,
    tokens: existing?.tokens,
  });

  if (
    existing &&
    existing.title === next.title &&
    existing.summary === next.summary &&
    existing.agentName === next.agentName &&
    existing.parentID === next.parentID &&
    existing.messageID === next.messageID &&
    existing.source === next.source &&
    existing.targetSessionID === next.targetSessionID &&
    existing.status === next.status &&
    existing.startedAt === next.startedAt &&
    existing.updatedAt === next.updatedAt &&
    existing.endedAt === next.endedAt &&
    sameTokens(existing.tokens, next.tokens)
  ) {
    return counted;
  }

  state.children[input.id] = next;
  reconcileSubtaskTargetCount(state, next);
  state.updatedAt = next.updatedAt;
  return true;
};

export const replaceChildren = (state: SubagentState, nextChildren: SubagentChild[]): boolean => {
  const nextState = createEmptyState();
  nextState.countedChildIDs = { ...state.countedChildIDs };
  nextState.totalExecuted = state.totalExecuted;
  nextState.updatedAt = state.updatedAt;

  for (const child of nextChildren) {
    upsertRunningChild(nextState, child);
    if (child.status === 'done' || child.status === 'error') {
      markChildStatus(nextState, child.id, child.status, child.endedAt ?? child.updatedAt);
    }
  }

  syncExecutionState(nextState);

  const changed =
    JSON.stringify(state.children) !== JSON.stringify(nextState.children) ||
    JSON.stringify(state.countedChildIDs) !== JSON.stringify(nextState.countedChildIDs) ||
    state.totalExecuted !== nextState.totalExecuted;

  state.children = nextState.children;
  state.countedChildIDs = nextState.countedChildIDs;
  state.totalExecuted = nextState.totalExecuted;
  state.updatedAt = changed ? new Date().toISOString() : state.updatedAt;
  return changed;
};

export const upsertChildDetails = (
  state: SubagentState,
  childID: string,
  input: {
    title?: string;
    summary?: string;
    agentName?: string;
    tokens?: SubagentTokens;
    targetSessionID?: string;
    updatedAt?: string;
  },
): boolean => {
  const existing = state.children[childID];
  if (!existing) return false;

  const nextTitle = typeof input.title === 'string' && input.title.trim().length > 0 ? input.title : existing.title;
  const nextSummary = sanitizeSummary(input.summary, nextTitle) ?? sanitizeSummary(existing.summary, nextTitle);
  const nextAgentName = sanitizeAgentName(input.agentName) ?? existing.agentName;
  const nextTokens = mergeTokens(existing.tokens, input.tokens);
  const nextTargetSessionID = sanitizeTargetSessionID(
    input.targetSessionID ?? existing.targetSessionID,
    existing.id.startsWith('ses_') ? existing.id : undefined,
  );
  const candidateUpdatedAt = safeTimestamp(input.updatedAt, existing.updatedAt ?? new Date().toISOString());
  const nextUpdatedAt =
    timestampMs(candidateUpdatedAt) >= childEvidenceTimestampMs(existing) ? candidateUpdatedAt : existing.updatedAt;

  if (
    nextTitle === existing.title &&
    nextSummary === existing.summary &&
    nextAgentName === existing.agentName &&
    nextTargetSessionID === existing.targetSessionID &&
    sameTokens(nextTokens, existing.tokens)
  ) {
    return false;
  }

  state.children[childID] = normalizeChild(
    {
      ...existing,
      title: nextTitle,
      summary: nextSummary,
      agentName: nextAgentName,
      targetSessionID: nextTargetSessionID,
      tokens: nextTokens,
      updatedAt: nextUpdatedAt,
    },
    Date.parse(nextUpdatedAt),
  );
  reconcileSubtaskTargetCount(state, state.children[childID]);
  state.updatedAt = nextUpdatedAt;
  return true;
};

export const mergeChildDetails = (
  state: SubagentState,
  childID: string,
  input: {
    title?: string;
    summary?: string;
    agentName?: string;
    tokens?: SubagentTokens;
    targetSessionID?: string;
    updatedAt?: string;
  },
): boolean => upsertChildDetails(state, childID, input);

export const markChildRunning = (state: SubagentState, childID: string, updatedAt?: string): boolean => {
  const resolvedUpdatedAt = safeTimestamp(updatedAt, new Date().toISOString());
  const nextEvidenceMs = timestampMs(resolvedUpdatedAt);
  let changed = false;

  for (const child of Object.values(state.children)) {
    if (child.id !== childID && child.targetSessionID !== childID) continue;

    const currentEvidenceMs = childEvidenceTimestampMs(child);
    const reopeningTerminal = isTerminalStatus(child.status);
    if ((reopeningTerminal && nextEvidenceMs <= currentEvidenceMs) || (!reopeningTerminal && nextEvidenceMs < currentEvidenceMs)) {
      continue;
    }

    const normalized = normalizeChild(
      {
        ...child,
        status: 'running',
        updatedAt: resolvedUpdatedAt,
        endedAt: undefined,
      },
      Date.parse(resolvedUpdatedAt),
    );

    if (
      child.status === normalized.status &&
      child.updatedAt === normalized.updatedAt &&
      child.endedAt === normalized.endedAt &&
      child.color === normalized.color &&
      child.elapsedMs === normalized.elapsedMs
    ) {
      continue;
    }

    clearPurgedSession(state, resolveSessionIdentity(child) ?? childID);
    state.children[child.id] = normalized;
    changed = true;
  }

  if (!changed) return false;

  state.updatedAt = resolvedUpdatedAt;
  return true;
};

export const markChildStatus = (
  state: SubagentState,
  childID: string,
  status: Exclude<SubagentChild['status'], 'running'>,
  endedAt?: string,
): boolean => {
  let changed = false;
  const resolvedEndedAt = safeTimestamp(endedAt, new Date().toISOString());
  const nextEvidenceMs = timestampMs(resolvedEndedAt);

  for (const child of Object.values(state.children)) {
    if (child.id !== childID && child.targetSessionID !== childID) continue;
    if (nextEvidenceMs < childEvidenceTimestampMs(child)) continue;
    if (child.status === status && child.endedAt === resolvedEndedAt && child.updatedAt === resolvedEndedAt) {
      continue;
    }

    clearPurgedSession(state, resolveSessionIdentity(child) ?? childID);

    state.children[child.id] = normalizeChild(
      {
        ...child,
        status,
        endedAt: resolvedEndedAt,
        updatedAt: resolvedEndedAt,
      },
      Date.parse(resolvedEndedAt),
    );
    changed = true;
  }

  if (!changed) return false;

  pruneTerminalChildren(state, Date.parse(resolvedEndedAt));
  state.updatedAt = resolvedEndedAt;
  return true;
};
