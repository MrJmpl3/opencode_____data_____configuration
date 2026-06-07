import type { TuiPluginApi } from '@opencode-ai/plugin/tui';

import { deriveSessionStatus, deriveTerminalSessionStatus } from '../domain/session-status.ts';
import { markChildRunning, markChildStatus, mergeChildDetails } from '../domain/state.ts';
import type { SubagentState } from '../domain/types.ts';
import { hasCompleteUsageMetrics } from '../domain/tokens.ts';
import { hydrateDoneChildTokens } from '../infrastructure/logs.ts';
import { isRecord, normalizedString, timestampFromUnknown } from '../shared/coercion.ts';

import { createSessionClientBoundary } from './boundaries/session-client.ts';
import { isRealSessionRow, resolveSessionRowSessionId } from './session-row.ts';

const messageInfo = (message: unknown): Record<string, unknown> | undefined => {
  const record = isRecord(message) ? message : undefined;
  return isRecord(record?.info) ? record.info : record;
};

const messageTime = (message: unknown, ...keys: string[]): string | undefined => {
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
};

const messageActivityAt = (message: unknown): string | undefined => {
  return messageTime(message, 'completed', 'updated', 'created');
};

export const latestSessionActivityAt = (api: TuiPluginApi, sessionId: string): string | undefined => {
  try {
    let latestMs = 0;
    for (const message of api.state.session.messages(sessionId)) {
      const timestamp = messageActivityAt(message);
      if (!timestamp) continue;
      latestMs = Math.max(latestMs, Date.parse(timestamp));
    }

    return latestMs > 0 ? new Date(latestMs).toISOString() : undefined;
  } catch {
    return undefined;
  }
};

export const sessionStatusEndedAt = (value: unknown): string | undefined => {
  if (!isRecord(value)) return undefined;

  const time = isRecord(value.time) ? value.time : undefined;
  return (
    timestampFromUnknown(time?.completed) ??
    timestampFromUnknown(time?.ended) ??
    timestampFromUnknown(time?.end) ??
    timestampFromUnknown(time?.updated)
  );
};

export const summarizeMessages = (messages: readonly unknown[]): { status?: 'done' | 'error'; endedAt?: string } => {
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
};

export const hydrateChildStatusesFromClient = async (
  api: TuiPluginApi,
  state: SubagentState,
  targetSessionIDs: readonly string[],
): Promise<boolean> => {
  const sessionClient = createSessionClientBoundary(api);

  const targets = Object.values(state.children).filter((child) => {
    if (!isRealSessionRow(child)) return false;
    const sessionId = resolveSessionRowSessionId(child);
    return Boolean(sessionId && targetSessionIDs.includes(sessionId));
  });
  if (targets.length === 0) return false;

  let statusBySessionID: Record<string, unknown> = {};

  try {
    statusBySessionID = await sessionClient.readStatusMap();
  } catch {
    statusBySessionID = {};
  }

  let changed = false;

  await Promise.all(
    targets.map(async (child) => {
      const sessionId = resolveSessionRowSessionId(child);
      if (!sessionId) return;

      const clientSessionStatus = statusBySessionID[sessionId];
      const clientStatus = deriveSessionStatus(clientSessionStatus);
      const clientTerminalStatus = deriveTerminalSessionStatus(clientSessionStatus);
      let messageSummary: { status?: 'done' | 'error'; endedAt?: string } = {};

      try {
        const messages = await sessionClient.readMessages(sessionId);
        messageSummary = summarizeMessages(messages);
      } catch {
        messageSummary = {};
      }

      const nextStatus = clientStatus === 'running' ? 'running' : (clientTerminalStatus ?? messageSummary.status);
      if (!nextStatus) return;

      if (nextStatus === 'running') {
        changed =
          markChildRunning(state, child.id, latestSessionActivityAt(api, sessionId) ?? child.updatedAt) || changed;
        return;
      }

      const endedAt =
        sessionStatusEndedAt(clientSessionStatus) ??
        messageSummary.endedAt ??
        latestSessionActivityAt(api, sessionId) ??
        child.endedAt ??
        child.updatedAt;
      changed = markChildStatus(state, child.id, nextStatus, endedAt) || changed;
    }),
  );

  if (changed) state.updatedAt = new Date().toISOString();

  return changed;
};

export const hydrateChildStatusesFromTuiState = (
  api: TuiPluginApi,
  state: SubagentState,
  targetSessionIDs: readonly string[],
): boolean => {
  if (targetSessionIDs.length === 0) return false;

  let changed = false;

  for (const child of Object.values(state.children)) {
    if (!isRealSessionRow(child)) continue;

    const sessionId = resolveSessionRowSessionId(child);
    if (!sessionId) continue;
    if (!targetSessionIDs.includes(sessionId)) continue;

    const latestActivityAt = latestSessionActivityAt(api, sessionId);
    const sessionStatus = api.state.session.status(sessionId);
    const status = deriveSessionStatus(sessionStatus);
    const terminalStatus = deriveTerminalSessionStatus(sessionStatus);
    const messageSummary = summarizeMessages(api.state.session.messages(sessionId));

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
        sessionStatusEndedAt(sessionStatus) ??
        messageSummary.endedAt ??
        latestActivityAt ??
        child.endedAt ??
        child.updatedAt;
      changed = markChildStatus(state, child.id, nextStatus, endedAt) || changed;
    }
  }

  if (changed) state.updatedAt = new Date().toISOString();

  return changed;
};

export const hydrateChildTokensFromLogs = async (state: SubagentState): Promise<boolean> => {
  let changed = false;

  for (const child of Object.values(state.children)) {
    if (child.status !== 'done') continue;
    if (hasCompleteUsageMetrics(child.tokens)) {
      continue;
    }

    const sessionId = resolveSessionRowSessionId(child);
    if (!sessionId) continue;

    const tokens = await hydrateDoneChildTokens(sessionId);
    if (!tokens) continue;

    changed = mergeChildDetails(state, child.id, { tokens }) || changed;
  }

  return changed;
};
