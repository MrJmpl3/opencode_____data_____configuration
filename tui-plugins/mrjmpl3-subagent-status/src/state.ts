import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import os from 'node:os';

import type { SubagentChild, SubagentCounts, SubagentState, SubagentTokens } from './types.ts';

const STATUS_DIRNAME = 'mrjmpl3-subagent-status';
const STATUS_FILENAME = 'state.json';
const STATUS_DIR_MODE = 0o700;
const STATUS_FILE_MODE = 0o600;
const TERMINAL_CHILD_RETENTION_MS = 30 * 60 * 1000;
const MAX_TERMINAL_CHILDREN = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function toNonNegativeInteger(value: unknown): number | undefined {
  const parsed = toFiniteNumber(value);
  if (parsed === undefined) return undefined;
  return Math.max(0, Math.floor(parsed));
}

function safeTimestamp(input: unknown, fallback: string): string {
  if (typeof input !== 'string') return fallback;
  return Number.isNaN(Date.parse(input)) ? fallback : input;
}

function sanitizeSummary(value: unknown, title: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  const summary = value.replace(/\s+/g, ' ').trim();
  if (!summary) return undefined;
  if (summary.toLowerCase() === title.replace(/\s+/g, ' ').trim().toLowerCase()) return undefined;
  return summary;
}

function sanitizeAgentName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const agentName = value
    .replace(/^\((.*)\)$/, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return agentName || undefined;
}

function sanitizeTargetSessionID(value: unknown, fallback?: string): string | undefined {
  if (typeof value === 'string' && value.startsWith('ses_')) return value;
  if (typeof fallback === 'string' && fallback.startsWith('ses_')) return fallback;
  return undefined;
}

function sanitizeTokens(input: unknown): SubagentTokens | undefined {
  if (!isRecord(input)) return undefined;

  const tokens: SubagentTokens = {
    input: toFiniteNumber(input.input),
    output: toFiniteNumber(input.output),
    total: toFiniteNumber(input.total),
    contextPercent: toFiniteNumber(input.contextPercent),
  };

  if (
    tokens.input === undefined &&
    tokens.output === undefined &&
    tokens.total === undefined &&
    tokens.contextPercent === undefined
  ) {
    return undefined;
  }

  return tokens;
}

function sameTokens(left: SubagentTokens | undefined, right: SubagentTokens | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeTokens(
  existing: SubagentTokens | undefined,
  incoming: SubagentTokens | undefined,
): SubagentTokens | undefined {
  if (!existing && !incoming) return undefined;

  return {
    input: incoming?.input ?? existing?.input,
    output: incoming?.output ?? existing?.output,
    total: incoming?.total ?? existing?.total,
    contextPercent: incoming?.contextPercent ?? existing?.contextPercent,
  };
}

function statusColor(status: SubagentChild['status']): NonNullable<SubagentChild['color']> {
  if (status === 'done') return 'green';
  if (status === 'error') return 'red';
  return 'yellow';
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

function normalizeExecutionCounters(state: SubagentState): void {
  state.totalExecuted = Math.max(
    toNonNegativeInteger(state.totalExecuted) ?? 0,
    Object.keys(state.countedChildIDs).length,
  );
}

function isRealSessionChild(child: Pick<SubagentChild, 'id'> & Partial<Pick<SubagentChild, 'source'>>): boolean {
  return child.source === 'session' || child.id.startsWith('ses_');
}

function isSyntheticToolWrapper(child: Partial<Pick<SubagentChild, 'source'>>): boolean {
  return child.source === 'tool';
}

function isSubtaskFallback(child: Partial<Pick<SubagentChild, 'source'>>): boolean {
  return child.source === 'subtask';
}

function matchingCorrelation(
  left: Pick<SubagentChild, 'parentID'> & Partial<Pick<SubagentChild, 'messageID'>>,
  right: Pick<SubagentChild, 'parentID'> & Partial<Pick<SubagentChild, 'messageID'>>,
): boolean {
  return Boolean(
    left.messageID && right.messageID && left.parentID === right.parentID && left.messageID === right.messageID,
  );
}

function findMatchingCountedSessionID(
  state: SubagentState,
  subtask: Pick<SubagentChild, 'parentID'> & Partial<Pick<SubagentChild, 'messageID' | 'targetSessionID'>>,
): string | undefined {
  if (subtask.targetSessionID && state.countedChildIDs[subtask.targetSessionID]) {
    return subtask.targetSessionID;
  }

  const matches = Object.values(state.children)
    .filter((child) => isRealSessionChild(child))
    .filter((child) => state.countedChildIDs[child.id])
    .filter((child) => matchingCorrelation(subtask, child))
    .map((child) => child.id);

  return matches.length === 1 ? matches[0] : undefined;
}

function findMatchingCountedSubtaskID(
  state: SubagentState,
  session: Pick<SubagentChild, 'id' | 'parentID'> & Partial<Pick<SubagentChild, 'messageID'>>,
): string | undefined {
  const byTarget = Object.values(state.children)
    .filter((child) => isSubtaskFallback(child))
    .filter((child) => state.countedChildIDs[child.id])
    .filter((child) => child.targetSessionID === session.id)
    .map((child) => child.id);
  if (byTarget.length === 1) return byTarget[0];

  const byCorrelation = Object.values(state.children)
    .filter((child) => isSubtaskFallback(child))
    .filter((child) => state.countedChildIDs[child.id])
    .filter((child) => matchingCorrelation(session, child))
    .map((child) => child.id);

  return byCorrelation.length === 1 ? byCorrelation[0] : undefined;
}

function rekeyCountedExecution(state: SubagentState, fromID: string, toID: string): boolean {
  if (fromID === toID || !state.countedChildIDs[fromID]) return false;

  const toAlreadyCounted = Boolean(state.countedChildIDs[toID]);
  delete state.countedChildIDs[fromID];
  if (!toAlreadyCounted) {
    state.countedChildIDs[toID] = true;
    normalizeExecutionCounters(state);
    return true;
  }

  state.totalExecuted = Math.max(
    Object.keys(state.countedChildIDs).length,
    (toNonNegativeInteger(state.totalExecuted) ?? 0) - 1,
  );
  return true;
}

function resolveExecutionCountIdentity(
  state: SubagentState,
  child: Pick<SubagentChild, 'id' | 'title' | 'parentID'> &
    Partial<Pick<SubagentChild, 'messageID' | 'source' | 'targetSessionID'>>,
): string | undefined {
  if (isSyntheticToolWrapper(child)) return undefined;

  if (isRealSessionChild(child)) {
    const matchingSubtaskID = findMatchingCountedSubtaskID(state, child);
    if (matchingSubtaskID) {
      rekeyCountedExecution(state, matchingSubtaskID, child.id);
      return undefined;
    }

    return child.id;
  }

  if (isSubtaskFallback(child)) {
    if (findMatchingCountedSessionID(state, child)) return undefined;
    return child.targetSessionID ?? child.id;
  }

  return child.id;
}

function countChildExecution(
  state: SubagentState,
  child: Pick<SubagentChild, 'id' | 'title' | 'parentID'> &
    Partial<Pick<SubagentChild, 'messageID' | 'source' | 'targetSessionID'>>,
): boolean {
  normalizeExecutionCounters(state);
  const countIdentity = resolveExecutionCountIdentity(state, child);
  if (!countIdentity || state.countedChildIDs[countIdentity]) return false;

  state.countedChildIDs[countIdentity] = true;
  state.totalExecuted = Math.max(
    toNonNegativeInteger(state.totalExecuted) ?? 0,
    Object.keys(state.countedChildIDs).length,
  );
  return true;
}

function reconcileSubtaskTargetCount(
  state: SubagentState,
  child: Pick<SubagentChild, 'id'> & Partial<Pick<SubagentChild, 'source' | 'targetSessionID'>>,
): boolean {
  if (!isSubtaskFallback(child) || !child.targetSessionID) return false;
  return rekeyCountedExecution(state, child.id, child.targetSessionID);
}

function normalizeChild(child: SubagentChild, nowMs = Date.now()): SubagentChild {
  const now = new Date(nowMs).toISOString();
  const status =
    child.status === 'done' || child.status === 'error' || child.status === 'running' ? child.status : 'running';
  const title = typeof child.title === 'string' && child.title.trim().length > 0 ? child.title : child.id;
  const startedAt = safeTimestamp(child.startedAt, now);
  const updatedAt = safeTimestamp(child.updatedAt, startedAt);
  const endedAt = child.endedAt ? safeTimestamp(child.endedAt, updatedAt) : undefined;

  return {
    ...child,
    title,
    summary: sanitizeSummary(child.summary, title),
    agentName: sanitizeAgentName(child.agentName),
    targetSessionID: sanitizeTargetSessionID(child.targetSessionID, child.id.startsWith('ses_') ? child.id : undefined),
    status,
    color: statusColor(status),
    startedAt,
    updatedAt,
    endedAt,
    elapsedMs: resolveElapsedMs({ startedAt, updatedAt, endedAt, status }, nowMs),
    tokens: sanitizeTokens(child.tokens),
  };
}

function safeReadJSON(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

async function writeLocalFile(path: string, contents: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: STATUS_DIR_MODE });

  const tempPath = join(directory, `.${basename(path)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, contents, { encoding: 'utf8', mode: STATUS_FILE_MODE });
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function terminalChildTimestamp(child: SubagentChild): number {
  const parsed = Date.parse(child.endedAt ?? child.updatedAt ?? child.startedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function createEmptyState(): SubagentState {
  return {
    children: {},
    countedChildIDs: {},
    totalExecuted: 0,
    updatedAt: new Date().toISOString(),
  };
}

export function resolveStatePath(): string {
  const fromEnv = process.env.MRJMPL3_SUBAGENT_STATUS_STATE;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv;

  const runtimeDir = process.env.XDG_RUNTIME_DIR ?? os.tmpdir();
  return join(runtimeDir, STATUS_DIRNAME, `pid-${process.pid}`, STATUS_FILENAME);
}

export function resolveTextPath(statePath: string): string {
  return join(dirname(statePath), 'status.txt');
}

export function shouldPreserveStateOnStartup(): boolean {
  return process.env.MRJMPL3_SUBAGENT_STATUS_PRESERVE_STATE === '1';
}

export function pruneTerminalChildren(state: SubagentState, now = Date.now()): boolean {
  const terminalChildren = Object.values(state.children)
    .filter((child) => child.status !== 'running')
    .sort((left, right) => terminalChildTimestamp(right) - terminalChildTimestamp(left));
  if (terminalChildren.length === 0) return false;

  const cutoff = now - TERMINAL_CHILD_RETENTION_MS;
  const keepIDs = new Set(
    terminalChildren
      .filter((child) => terminalChildTimestamp(child) >= cutoff)
      .slice(0, MAX_TERMINAL_CHILDREN)
      .map((child) => child.id),
  );

  let changed = false;
  for (const child of terminalChildren) {
    if (keepIDs.has(child.id)) continue;
    delete state.children[child.id];
    changed = true;
  }

  return changed;
}

export async function loadState(statePath: string): Promise<SubagentState> {
  try {
    const raw = await readFile(statePath, 'utf8');
    const parsed = safeReadJSON(raw);
    if (!isRecord(parsed)) return createEmptyState();

    const state = createEmptyState();
    state.updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : state.updatedAt;

    if (isRecord(parsed.countedChildIDs)) {
      for (const [id, value] of Object.entries(parsed.countedChildIDs)) {
        if (value === true && id) state.countedChildIDs[id] = true;
      }
    }
    state.totalExecuted = Math.max(
      toNonNegativeInteger(parsed.totalExecuted) ?? 0,
      Object.keys(state.countedChildIDs).length,
    );

    const rawChildren = isRecord(parsed.children) ? parsed.children : {};
    for (const [id, value] of Object.entries(rawChildren)) {
      if (!isRecord(value)) continue;
      if (typeof value.parentID !== 'string') continue;

      const child = normalizeChild(
        {
          id: typeof value.id === 'string' ? value.id : id,
          title: typeof value.title === 'string' ? value.title : id,
          summary: typeof value.summary === 'string' ? value.summary : undefined,
          agentName: typeof value.agentName === 'string' ? value.agentName : undefined,
          parentID: value.parentID,
          messageID: typeof value.messageID === 'string' ? value.messageID : undefined,
          source:
            value.source === 'session' || value.source === 'subtask' || value.source === 'tool'
              ? value.source
              : undefined,
          targetSessionID: typeof value.targetSessionID === 'string' ? value.targetSessionID : undefined,
          status: value.status === 'done' || value.status === 'error' ? value.status : 'running',
          color: value.color === 'green' || value.color === 'red' || value.color === 'yellow' ? value.color : undefined,
          startedAt: typeof value.startedAt === 'string' ? value.startedAt : state.updatedAt,
          updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : state.updatedAt,
          endedAt: typeof value.endedAt === 'string' ? value.endedAt : undefined,
          elapsedMs: toFiniteNumber(value.elapsedMs),
          tokens: sanitizeTokens(value.tokens),
        },
        Date.parse(state.updatedAt),
      );
      state.children[child.id] = child;
    }

    for (const child of Object.values(state.children)) {
      if (child.source === 'subtask' && child.targetSessionID && state.countedChildIDs[child.id]) {
        rekeyCountedExecution(state, child.id, child.targetSessionID);
      }

      const countIdentity = resolveExecutionCountIdentity(state, child);
      if (countIdentity && !state.countedChildIDs[countIdentity] && !isSyntheticToolWrapper(child)) {
        state.countedChildIDs[countIdentity] = true;
      }
    }

    normalizeExecutionCounters(state);
    if (pruneTerminalChildren(state, Date.now())) {
      state.updatedAt = new Date().toISOString();
    }

    return state;
  } catch {
    return createEmptyState();
  }
}

export async function saveStatusText(textPath: string, contents: string): Promise<void> {
  await writeLocalFile(textPath, contents);
}

export async function saveState(statePath: string, state: SubagentState): Promise<void> {
  await writeLocalFile(statePath, JSON.stringify(state, null, 2));
}

export function getCounts(state: SubagentState): SubagentCounts {
  const counts: SubagentCounts = { running: 0, done: 0, error: 0 };
  for (const child of Object.values(state.children)) {
    if (child.status === 'running') counts.running += 1;
    if (child.status === 'done') counts.done += 1;
    if (child.status === 'error') counts.error += 1;
  }

  return counts;
}

export function upsertRunningChild(
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
): boolean {
  const now = new Date().toISOString();
  const existing = state.children[input.id];
  const source = input.source ?? existing?.source ?? (input.id.startsWith('ses_') ? 'session' : undefined);
  const observedUpdatedAt = safeTimestamp(input.updatedAt, now);
  const observedStartedAt = safeTimestamp(input.startedAt, existing?.startedAt ?? observedUpdatedAt);
  const targetSessionID = sanitizeTargetSessionID(
    input.targetSessionID ?? existing?.targetSessionID,
    input.id.startsWith('ses_') ? input.id : undefined,
  );
  const status =
    input.status === 'done' || input.status === 'error' || input.status === 'running'
      ? input.status
      : (existing?.status ?? 'running');

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
    updatedAt: observedUpdatedAt,
    endedAt: status === 'running' ? undefined : (input.endedAt ?? existing?.endedAt),
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
}

export function replaceChildren(state: SubagentState, nextChildren: SubagentChild[]): boolean {
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

  const changed =
    JSON.stringify(state.children) !== JSON.stringify(nextState.children) ||
    JSON.stringify(state.countedChildIDs) !== JSON.stringify(nextState.countedChildIDs) ||
    state.totalExecuted !== nextState.totalExecuted;

  state.children = nextState.children;
  state.countedChildIDs = nextState.countedChildIDs;
  state.totalExecuted = nextState.totalExecuted;
  state.updatedAt = changed ? new Date().toISOString() : state.updatedAt;
  return changed;
}

export function upsertChildDetails(
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
): boolean {
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
  const nextUpdatedAt = safeTimestamp(input.updatedAt, new Date().toISOString());

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
}

export function mergeChildDetails(
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
): boolean {
  return upsertChildDetails(state, childID, input);
}

export function markChildStatus(
  state: SubagentState,
  childID: string,
  status: Exclude<SubagentChild['status'], 'running'>,
  endedAt?: string,
): boolean {
  let changed = false;
  const resolvedEndedAt = safeTimestamp(endedAt, new Date().toISOString());

  for (const child of Object.values(state.children)) {
    if (child.id !== childID && child.targetSessionID !== childID) continue;
    if (child.status === status && child.endedAt === resolvedEndedAt && child.updatedAt === resolvedEndedAt) {
      continue;
    }

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
}
