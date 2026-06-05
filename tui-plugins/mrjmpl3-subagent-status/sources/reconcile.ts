import {
  clearPurgedSession,
  markChildStatus,
  pruneOrphanedSyntheticRunningChildren,
  pruneTerminalChildren,
  upsertRunningChild,
} from '../state/state.ts';
import type { SubagentChild, SubagentState, SubagentTokens } from '../state/types.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function timestampFromUnknown(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const millis = value < 10_000_000_000 ? value * 1000 : value;
    const parsed = new Date(millis);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
  }

  return undefined;
}

function sessionTime(input: Record<string, unknown>, key: 'created' | 'updated'): string | undefined {
  const time = isRecord(input.time) ? input.time : undefined;
  return timestampFromUnknown(time?.[key]);
}

export function deriveOpenCodeSessionStatus(value: unknown): SubagentChild['status'] | undefined {
  const statuses = collectStatusValues(value);
  if (statuses.some((status) => ERROR_SESSION_STATUS_VALUES.has(status))) return 'error';
  if (statuses.some((status) => RUNNING_SESSION_STATUS_VALUES.has(status))) return 'running';
  if (statuses.some((status) => DONE_SESSION_STATUS_VALUES.has(status))) return 'done';
  return undefined;
}

function collectStatusValues(value: unknown): string[] {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized ? [normalized] : [];
  }

  const record = isRecord(value) ? value : undefined;
  if (!record) return [];

  const statuses = [record.type, record.status, record.state, record.phase, record.result]
    .map((candidate) => (typeof candidate === 'string' ? candidate.trim().toLowerCase() : undefined))
    .filter((candidate): candidate is string => Boolean(candidate));

  if (record.error) statuses.push('error');
  if (record.busy === true || record.running === true) statuses.push('busy');
  return statuses;
}

const RUNNING_SESSION_STATUS_VALUES = new Set([
  'busy',
  'running',
  'pending',
  'queued',
  'in_progress',
  'working',
  'compacting',
  'retry',
]);
const DONE_SESSION_STATUS_VALUES = new Set(['done', 'completed', 'complete', 'success', 'succeeded']);
const ERROR_SESSION_STATUS_VALUES = new Set(['error', 'failed', 'failure', 'cancelled', 'canceled', 'aborted']);

function normalizeTokens(value: unknown): SubagentTokens | undefined {
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
}

function normalizeChild(input: unknown): SubagentChild | undefined {
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
    color: status === 'done' ? 'green' : status === 'error' ? 'red' : 'yellow',
    startedAt,
    updatedAt,
    endedAt: asString(input.endedAt) ?? (status === 'running' ? undefined : updatedAt),
    elapsedMs: undefined,
    tokens: normalizeTokens(input.tokens),
  };
}

export function normalizeChildrenResponse(response: unknown): SubagentChild[] {
  const data = isRecord(response) ? response.data : response;
  if (!Array.isArray(data)) return [];
  return data.map(normalizeChild).filter((child): child is SubagentChild => Boolean(child));
}

function isRealSessionChild(child: SubagentChild): boolean {
  return child.source === 'session' || child.id.startsWith('ses_');
}

function cloneState(state: SubagentState): SubagentState {
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
}

function sameChild(left: SubagentChild | undefined, right: SubagentChild | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function reconcileChildrenState(
  state: SubagentState,
  response: unknown,
): { changed: boolean; nextState: SubagentState } {
  const nextState = cloneState(state);
  const incomingChildren = normalizeChildrenResponse(response);
  const incomingIDs = new Set(incomingChildren.map((child) => child.id));
  const hadRealSessionChildren = Object.values(state.children).some(
    (child) => child.source === 'session' || child.id.startsWith('ses_'),
  );
  let changed = false;

  for (const child of incomingChildren) {
    const before = nextState.children[child.id];
    changed = upsertRunningChild(nextState, child) || changed;
    if (child.status === 'done' || child.status === 'error') {
      changed = markChildStatus(nextState, child.id, child.status, child.endedAt ?? child.updatedAt) || changed;
    }

    if (!sameChild(before, nextState.children[child.id])) {
      changed = true;
    }
  }

  for (const existing of Object.values(state.children)) {
    if (!isRealSessionChild(existing)) continue;
    if (incomingIDs.has(existing.id)) continue;
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
}
