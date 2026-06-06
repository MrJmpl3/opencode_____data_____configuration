import type { TuiPluginApi } from '@opencode-ai/plugin/tui';

import { deriveSessionStatus, deriveTerminalSessionStatus } from '../domain/session-status.ts';
import { markChildRunning, markChildStatus, mergeChildDetails } from '../domain/state.ts';
import type { SubagentState } from '../domain/types.ts';
import { hydrateDoneChildTokens } from '../infrastructure/logs.ts';

import { isRealSessionRow, resolveSessionRowSessionID } from './session-row.ts';

type SessionClient = {
  status?: (input: { directory: string }) => Promise<{ data?: Record<string, unknown> } | undefined>;
  messages?: (input: { sessionID: string; directory: string }) => Promise<{ data?: unknown[] } | undefined>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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

function normalizedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().toLowerCase() : undefined;
}

function messageInfo(message: unknown): Record<string, unknown> | undefined {
  const record = isRecord(message) ? message : undefined;
  return isRecord(record?.info) ? record.info : record;
}

function messageTime(message: unknown, ...keys: string[]): string | undefined {
  const record = isRecord(message) ? message : undefined;
  const info = messageInfo(message);
  const state = isRecord(record?.state) ? record.state : undefined;
  const sources = [
    isRecord(record?.time) ? record.time : undefined,
    isRecord(info?.time) ? info.time : undefined,
    isRecord(state?.time) ? state.time : undefined,
    state,
    info,
    record,
  ];

  for (const source of sources) {
    if (!source) continue;
    for (const key of keys) {
      const timestamp = timestampFromUnknown(source[key]);
      if (timestamp) return timestamp;
    }
  }

  return undefined;
}

function messageActivityAt(message: unknown): string | undefined {
  return messageTime(message, 'completed', 'updated', 'created');
}

export function latestSessionActivityAt(api: TuiPluginApi, sessionID: string): string | undefined {
  try {
    let latestMs = 0;
    for (const message of api.state.session.messages(sessionID)) {
      const timestamp = messageActivityAt(message);
      if (!timestamp) continue;
      latestMs = Math.max(latestMs, Date.parse(timestamp));
    }

    return latestMs > 0 ? new Date(latestMs).toISOString() : undefined;
  } catch {
    return undefined;
  }
}

export function sessionStatusEndedAt(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;

  const time = isRecord(value.time) ? value.time : undefined;
  return (
    timestampFromUnknown(time?.completed) ??
    timestampFromUnknown(time?.ended) ??
    timestampFromUnknown(time?.end) ??
    timestampFromUnknown(time?.updated)
  );
}

export function summarizeMessages(messages: readonly unknown[]): { status?: 'done' | 'error'; endedAt?: string } {
  let completedAtMs = 0;
  let errorAtMs = 0;

  for (const message of messages) {
    const record = isRecord(message) ? message : undefined;
    const info = messageInfo(message);
    const state = isRecord(record?.state) ? record.state : undefined;
    const status =
      deriveTerminalSessionStatus(state?.status ?? info?.status ?? record?.status ?? state ?? info ?? record) ??
      (record?.error || info?.error || state?.error ? 'error' : undefined);
    const type = normalizedString(record?.type ?? info?.type ?? state?.type);
    const reason = normalizedString(record?.reason ?? info?.reason ?? state?.reason);
    const terminalAt =
      messageTime(message, 'completed', 'end', 'ended', 'updated', 'created') ?? messageActivityAt(message);

    if (status === 'error' && terminalAt) {
      errorAtMs = Math.max(errorAtMs, Date.parse(terminalAt));
      continue;
    }

    const hasStrictDoneSignal =
      (type === 'session.status' && status === 'done') || (type === 'step-finish' && reason === 'stop');
    if (hasStrictDoneSignal && terminalAt) {
      completedAtMs = Math.max(completedAtMs, Date.parse(terminalAt));
    }
  }

  if (errorAtMs > completedAtMs) return { status: 'error', endedAt: new Date(errorAtMs).toISOString() };
  if (completedAtMs > 0) return { status: 'done', endedAt: new Date(completedAtMs).toISOString() };

  return {};
}

export async function hydrateChildStatusesFromClient(
  api: TuiPluginApi,
  state: SubagentState,
  targetSessionIDs: readonly string[],
): Promise<boolean> {
  const sessionClient = api.client.session as unknown as SessionClient | undefined;
  if (!sessionClient) return false;

  const targets = Object.values(state.children).filter((child) => {
    if (!isRealSessionRow(child)) return false;
    const sessionID = resolveSessionRowSessionID(child);
    return Boolean(sessionID && targetSessionIDs.includes(sessionID));
  });
  if (targets.length === 0) return false;

  const directory = api.state.path.directory;
  let statusBySessionID: Record<string, unknown> = {};

  try {
    statusBySessionID = (await sessionClient.status?.({ directory }))?.data ?? {};
  } catch {
    statusBySessionID = {};
  }

  let changed = false;

  await Promise.all(
    targets.map(async (child) => {
      const sessionID = resolveSessionRowSessionID(child);
      if (!sessionID) return;

      const clientSessionStatus = statusBySessionID[sessionID];
      const clientStatus = deriveSessionStatus(clientSessionStatus);
      const clientTerminalStatus = deriveTerminalSessionStatus(clientSessionStatus);
      let messageSummary: { status?: 'done' | 'error'; endedAt?: string } = {};

      try {
        const messages = (await sessionClient.messages?.({ sessionID, directory }))?.data ?? [];
        messageSummary = summarizeMessages(messages);
      } catch {
        messageSummary = {};
      }

      const nextStatus = clientStatus === 'running' ? 'running' : clientTerminalStatus ?? messageSummary.status;
      if (!nextStatus) return;

      if (nextStatus === 'running') {
        changed = markChildRunning(state, child.id, latestSessionActivityAt(api, sessionID) ?? child.updatedAt) || changed;
        return;
      }

      const endedAt =
        sessionStatusEndedAt(clientSessionStatus) ??
        messageSummary.endedAt ??
        latestSessionActivityAt(api, sessionID) ??
        child.endedAt ??
        child.updatedAt;
      changed = markChildStatus(state, child.id, nextStatus, endedAt) || changed;
    }),
  );

  if (changed) state.updatedAt = new Date().toISOString();

  return changed;
}

export function hydrateChildStatusesFromTuiState(
  api: TuiPluginApi,
  state: SubagentState,
  targetSessionIDs: readonly string[],
): boolean {
  if (targetSessionIDs.length === 0) return false;

  let changed = false;

  for (const child of Object.values(state.children)) {
    if (!isRealSessionRow(child)) continue;

    const sessionID = resolveSessionRowSessionID(child);
    if (!sessionID) continue;
    if (!targetSessionIDs.includes(sessionID)) continue;

    const latestActivityAt = latestSessionActivityAt(api, sessionID);
    const sessionStatus = api.state.session.status(sessionID);
    const status = deriveSessionStatus(sessionStatus);
    const terminalStatus = deriveTerminalSessionStatus(sessionStatus);
    const messageSummary = summarizeMessages(api.state.session.messages(sessionID));

    if (status === 'running') {
      changed = markChildRunning(state, child.id, latestActivityAt ?? child.updatedAt) || changed;
      continue;
    }

    if (status === 'error') {
      const endedAt = latestActivityAt ?? child.endedAt ?? child.updatedAt;
      changed = markChildStatus(state, child.id, 'error', endedAt) || changed;
      continue;
    }

    const nextStatus = terminalStatus ?? messageSummary.status;
    if (nextStatus) {
      const endedAt =
        sessionStatusEndedAt(sessionStatus) ?? messageSummary.endedAt ?? latestActivityAt ?? child.endedAt ?? child.updatedAt;
      changed = markChildStatus(state, child.id, nextStatus, endedAt) || changed;
    }
  }

  if (changed) state.updatedAt = new Date().toISOString();

  return changed;
}

export function hydrateChildTokensFromLogs(state: SubagentState): boolean {
  let changed = false;

  for (const child of Object.values(state.children)) {
    if (child.status !== 'done') continue;
    if (child.tokens?.total !== undefined || child.tokens?.input !== undefined || child.tokens?.output !== undefined) {
      continue;
    }

    const sessionID = resolveSessionRowSessionID(child);
    if (!sessionID) continue;

    const tokens = hydrateDoneChildTokens(sessionID);
    if (!tokens) continue;

    changed = mergeChildDetails(state, child.id, { tokens }) || changed;
  }

  return changed;
}
