import {
  clearPurgedSession,
  isTerminalStatus,
  markChildStatus,
  normalizeChild as normalizeStateChild,
  pruneOrphanedSyntheticRunningChildren,
  pruneTerminalChildren,
  upsertRunningChild,
} from './state.ts';
import { deriveOpenCodeSessionStatus } from './session-status.ts';
import { sameSubagentTokens } from './tokens.ts';
import type { SubagentChild, SubagentState, SubagentTokens } from './types.ts';
import { asString, isPlainObject as isRecord, timestampFromUnknown } from '@mrjmpl3/tui-kit';

const sessionTime = (input: Record<string, unknown>, key: 'created' | 'updated'): string | undefined => {
  const time = isRecord(input.time) ? input.time : undefined;
  return timestampFromUnknown(time?.[key]);
};

const normalizeTokens = (value: unknown): SubagentTokens | undefined => {
  if (!isRecord(value)) return undefined;

  const input = typeof value.input === 'number' && Number.isFinite(value.input) ? value.input : undefined;
  const output = typeof value.output === 'number' && Number.isFinite(value.output) ? value.output : undefined;
  const total = typeof value.total === 'number' && Number.isFinite(value.total) ? value.total : undefined;
  const contextPercent =
    typeof value.contextPercent === 'number' && Number.isFinite(value.contextPercent)
      ? value.contextPercent
      : undefined;

  if (input === undefined && output === undefined && total === undefined && contextPercent === undefined) {
    return undefined;
  }

  return { input, output, total, contextPercent };
};

const normalizeResponseChild = (input: unknown): SubagentChild | undefined => {
  if (!isRecord(input)) return undefined;

  const id = asString(input.id);
  const parentID = asString(input.parentID);
  if (!id || !parentID) return undefined;

  const title = asString(input.title) ?? asString(input.name) ?? 'Subagent';
  const startedAt = asString(input.startedAt) ?? sessionTime(input, 'created') ?? new Date().toISOString();
  const updatedAt = asString(input.updatedAt) ?? sessionTime(input, 'updated') ?? startedAt;
  const status = deriveOpenCodeSessionStatus(input.status ?? input.state) ?? 'running';

  return {
    id,
    title,
    summary: asString(input.summary),
    agentName: asString(input.agentName),
    parentID,
    messageID: asString(input.messageID),
    source:
      input.source === 'session' || input.source === 'subtask' || input.source === 'tool'
        ? input.source
        : id.startsWith('ses_')
          ? 'session'
          : undefined,
    targetSessionID: asString(input.targetSessionID) ?? (id.startsWith('ses_') ? id : undefined),
    status,
    color: status === 'done' ? 'green' : status === 'error' ? 'red' : status === 'stale' ? 'gray' : 'yellow',
    startedAt,
    updatedAt,
    endedAt: asString(input.endedAt) ?? (status === 'running' ? undefined : updatedAt),
    elapsedMs: undefined,
    tokens: normalizeTokens(input.tokens),
  };
};

export const normalizeChildrenResponse = (response: unknown): SubagentChild[] => {
  const data = isRecord(response) ? response.data : response;
  if (!Array.isArray(data)) return [];
  return data.map(normalizeResponseChild).filter((child): child is SubagentChild => Boolean(child));
};

type ReconcileChildrenStateOptions = {
  recoverySessionIDs?: ReadonlySet<string>;
  terminalRecoverySessionIDs?: ReadonlySet<string>;
};

const isRealSessionChild = (child: SubagentChild): boolean => {
  return child.source === 'session' || child.id.startsWith('ses_');
};

const resolveRealSessionID = (child: SubagentChild): string | undefined => {
  if (!isRealSessionChild(child)) return undefined;
  return child.targetSessionID ?? (child.id.startsWith('ses_') ? child.id : undefined);
};

const collectTerminalRecoveryChildren = (
  state: SubagentState,
  terminalRecoverySessionIDs: ReadonlySet<string> | undefined,
): Map<string, SubagentChild> => {
  const terminalRecoveryChildren = new Map<string, SubagentChild>();
  if (!terminalRecoverySessionIDs?.size) return terminalRecoveryChildren;

  for (const child of Object.values(state.children)) {
    if (!isRealSessionChild(child) || !isTerminalStatus(child.status)) continue;

    const sessionID = resolveRealSessionID(child);
    if (!sessionID || !terminalRecoverySessionIDs.has(sessionID)) continue;

    if (!terminalRecoveryChildren.has(sessionID) || child.id === sessionID) {
      terminalRecoveryChildren.set(sessionID, child);
    }
  }

  return terminalRecoveryChildren;
};

const inheritTerminalRecoveryStatus = (child: SubagentChild, terminalChild: SubagentChild): SubagentChild => {
  if (!isTerminalStatus(terminalChild.status)) return child;

  const endedAt = terminalChild.endedAt ?? terminalChild.updatedAt;

  return {
    ...child,
    status: terminalChild.status,
    updatedAt: endedAt,
    endedAt,
  };
};

const resolveIncomingChild = (
  child: SubagentChild,
  terminalRecoveryChildren: ReadonlyMap<string, SubagentChild>,
): { child: SubagentChild; inheritedTerminalRecovery: boolean; sessionID?: string } => {
  const sessionID = resolveRealSessionID(child);
  const terminalRecoveryChild = sessionID ? terminalRecoveryChildren.get(sessionID) : undefined;

  if (child.status !== 'running' || !terminalRecoveryChild) {
    return { child, inheritedTerminalRecovery: false, sessionID };
  }

  return {
    child: inheritTerminalRecoveryStatus(child, terminalRecoveryChild),
    inheritedTerminalRecovery: true,
    sessionID,
  };
};

const canReopenTerminalChild = (
  child: SubagentChild,
  sessionID: string | undefined,
  terminalRecoverySessionIDs: ReadonlySet<string> | undefined,
): boolean => {
  return !(child.status === 'running' && sessionID && terminalRecoverySessionIDs?.has(sessionID));
};

const isNewTerminalRecoveryAlias = (
  existing: SubagentChild | undefined,
  incomingChild: SubagentChild,
  sessionID: string | undefined,
  inheritedTerminalRecovery: boolean,
): boolean => {
  return !existing && inheritedTerminalRecovery && Boolean(sessionID && incomingChild.id !== sessionID);
};

const cloneState = (state: SubagentState): SubagentState => {
  return {
    ...state,
    children: Object.fromEntries(
      Object.entries(state.children).map(([id, child]) => [
        id,
        {
          ...child,
          tokens: child.tokens ? { ...child.tokens } : undefined,
        },
      ]),
    ),
    countedChildIDs: { ...state.countedChildIDs },
  };
};

const sameChild = (left: SubagentChild | undefined, right: SubagentChild | undefined): boolean => {
  if (left === right) return true;
  if (!left || !right) return false;

  return (
    left.id === right.id &&
    left.status === right.status &&
    left.updatedAt === right.updatedAt &&
    left.endedAt === right.endedAt &&
    left.summary === right.summary &&
    left.agentName === right.agentName &&
    left.targetSessionID === right.targetSessionID &&
    left.color === right.color &&
    left.elapsedMs === right.elapsedMs &&
    left.title === right.title &&
    left.parentID === right.parentID &&
    left.messageID === right.messageID &&
    left.source === right.source &&
    left.startedAt === right.startedAt &&
    sameSubagentTokens(left.tokens, right.tokens)
  );
};

const normalizeAt = (timestamp: string): number => {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? Date.now() : parsed;
};

const applyTerminalRecoveryToExistingAliases = (
  state: SubagentState,
  terminalRecoveryChildren: ReadonlyMap<string, SubagentChild>,
): boolean => {
  if (terminalRecoveryChildren.size === 0) return false;

  let changed = false;

  for (const child of Object.values(state.children)) {
    if (child.status !== 'running') continue;
    if (!isRealSessionChild(child)) continue;

    const sessionID = child.targetSessionID;
    if (!sessionID || child.id === sessionID) continue;

    const terminalChild = terminalRecoveryChildren.get(sessionID);
    if (!terminalChild) continue;

    const endedAt = terminalChild.endedAt ?? terminalChild.updatedAt;
    const next = normalizeStateChild(inheritTerminalRecoveryStatus(child, terminalChild), normalizeAt(endedAt));
    if (sameChild(child, next)) continue;

    state.children[child.id] = next;
    changed = true;
  }

  return changed;
};

export const reconcileNormalizedChildrenState = (
  state: SubagentState,
  incomingChildren: readonly SubagentChild[],
  options: ReconcileChildrenStateOptions = {},
): { changed: boolean; nextState: SubagentState } => {
  const nextState = cloneState(state);
  const incomingIDs = new Set(incomingChildren.map((child) => child.id));
  const terminalRecoveryChildren = collectTerminalRecoveryChildren(nextState, options.terminalRecoverySessionIDs);
  const hadRealSessionChildren = Object.values(state.children).some(
    (child) => child.source === 'session' || child.id.startsWith('ses_'),
  );
  let changed = false;

  for (const incomingChild of incomingChildren) {
    const before = nextState.children[incomingChild.id];
    const { child, inheritedTerminalRecovery, sessionID } = resolveIncomingChild(
      incomingChild,
      terminalRecoveryChildren,
    );
    if (isNewTerminalRecoveryAlias(before, incomingChild, sessionID, inheritedTerminalRecovery)) {
      continue;
    }

    const allowTerminalReopen = canReopenTerminalChild(incomingChild, sessionID, options.terminalRecoverySessionIDs);

    changed = upsertRunningChild(nextState, child, { allowTerminalReopen }) || changed;
    if (isTerminalStatus(child.status)) {
      changed =
        markChildStatus(nextState, child.id, child.status, child.endedAt ?? child.updatedAt, {
          allowOlderTerminalEvidence: inheritedTerminalRecovery,
        }) || changed;
    }

    if (!sameChild(before, nextState.children[child.id])) {
      changed = true;
    }
  }

  changed = applyTerminalRecoveryToExistingAliases(nextState, terminalRecoveryChildren) || changed;

  for (const existing of Object.values(state.children)) {
    if (!isRealSessionChild(existing)) continue;
    if (incomingIDs.has(existing.id)) continue;
    const existingSessionID = resolveRealSessionID(existing);
    if (existingSessionID && options.recoverySessionIDs?.has(existingSessionID)) continue;
    if (existing.status === 'running') continue;
    nextState.purgedSessionIDs[existing.id] = true;
    delete nextState.children[existing.id];
    changed = true;
  }

  const pruneReferenceMs = Date.parse(nextState.updatedAt);
  const pruned = pruneTerminalChildren(nextState, Number.isNaN(pruneReferenceMs) ? Date.now() : pruneReferenceMs);
  const prunedSynthetic = pruneOrphanedSyntheticRunningChildren(nextState, {
    pruneWhenNoRealSessionChildren: hadRealSessionChildren,
  });
  if (changed || pruned || prunedSynthetic) {
    nextState.updatedAt = new Date().toISOString();
  }

  return {
    changed: changed || pruned || prunedSynthetic,
    nextState,
  };
};

export const reconcileChildrenState = (
  state: SubagentState,
  response: unknown,
  options: ReconcileChildrenStateOptions = {},
): { changed: boolean; nextState: SubagentState } => {
  return reconcileNormalizedChildrenState(state, normalizeChildrenResponse(response), options);
};
