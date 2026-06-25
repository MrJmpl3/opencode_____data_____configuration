import type { TuiPluginApi } from '@opencode-ai/plugin/tui';

import { deriveSessionStatus, deriveTerminalSessionStatus } from '../domain/session-status.ts';
import { markChildRunning, markChildStatus, mergeChildDetails } from '../domain/state.ts';
import type { SubagentChild, SubagentState } from '../domain/types.ts';
import { hasCompleteUsageMetrics } from '../domain/tokens.ts';
import { hydrateDoneChildTokens } from '../infrastructure/logs.ts';
import { debugLog } from '../shared/debug.ts';
import { isPlainObject as isRecord, normalizedString, timestampFromUnknown } from '@mrjmpl3/tui-kit';

import { createSessionClientBoundary } from './boundaries/session-client.ts';
import { isRealSessionRow, resolveSessionRowSessionId } from './session-row.ts';

type RunningEvidenceCollector = Set<string>;

type MessageSummary = { status?: 'done' | 'error'; endedAt?: string; evidence?: 'explicit' | 'ambiguous' };

type MessageActivity = {
  summary: MessageSummary;
  latestActivityAt?: string;
  latestLiveActivityAt?: string;
};

type StatusHydrationOptions = {
  terminalRecoverySessionIDs?: ReadonlySet<string>;
};

/**
 * Strategy for reading session status and message activity from different sources.
 * Used by wrapper functions to abstract how status/activity data is obtained.
 */
type HydrationStrategy = {
  readSessionStatus: (sessionId: string) => unknown;
  readMessageActivity: (sessionId: string) => MessageActivity;
};

const isRecoveryProtectedFromRunning = (sessionId: string, options: StatusHydrationOptions | undefined): boolean => {
  return options?.terminalRecoverySessionIDs?.has(sessionId) === true;
};

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

const messageLiveActivityAt = (message: unknown): string | undefined => {
  return messageTime(message, 'updated', 'created');
};

const latestISOString = (timestampMs: number): string | undefined => {
  return timestampMs > 0 ? new Date(timestampMs).toISOString() : undefined;
};

const maxTimestamp = (currentMs: number, timestamp: string | undefined): number => {
  if (!timestamp) return currentMs;

  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? currentMs : Math.max(currentMs, parsed);
};

const resolveStepStartTimestamp = (message: unknown): string | undefined => {
  return messageTime(message, 'start', 'started', 'created', 'updated');
};

const resolveAmbiguousStepFinishStatus = (message: unknown): MessageSummary['status'] => {
  const record = isRecord(message) ? message : undefined;
  const info = messageInfo(message);
  const state = isRecord(record?.state) ? record.state : undefined;
  const type = normalizedString(record?.type ?? info?.type ?? state?.type);
  if (type !== 'step-finish') return undefined;
  if (record?.error || info?.error || state?.error) return 'error';

  const reason = normalizedString(record?.reason ?? info?.reason ?? state?.reason ?? record?.status ?? info?.status);
  const terminalReason = deriveTerminalSessionStatus(reason);
  if (terminalReason === 'done' || terminalReason === 'error') return terminalReason;

  return reason === 'stop' ? 'done' : undefined;
};

const isNewerTimestamp = (candidate: string | undefined, baseline: string | undefined): boolean => {
  if (!candidate || !baseline) return false;

  return Date.parse(candidate) > Date.parse(baseline);
};

const emptyMessageActivity = (): MessageActivity => ({ summary: {} });

const analyzeMessages = (messages: readonly unknown[]): MessageActivity => {
  let latestActivityMs = 0;
  let latestLiveActivityMs = 0;
  let completedAtMs = 0;
  let errorAtMs = 0;
  let ambiguousCompletedAtMs = 0;
  let ambiguousErrorAtMs = 0;
  let latestStepStartAtMs = 0;

  for (const message of messages) {
    latestActivityMs = maxTimestamp(latestActivityMs, messageActivityAt(message));
    latestLiveActivityMs = maxTimestamp(latestLiveActivityMs, messageLiveActivityAt(message));

    const record = isRecord(message) ? message : undefined;
    const info = messageInfo(message);
    const state = isRecord(record?.state) ? record.state : undefined;
    const status =
      deriveTerminalSessionStatus(state?.status ?? info?.status ?? record?.status ?? state ?? info ?? record) ??
      (record?.error || info?.error || state?.error ? 'error' : undefined);
    const type = normalizedString(record?.type ?? info?.type ?? state?.type);
    if (type === 'step-start') {
      latestStepStartAtMs = maxTimestamp(latestStepStartAtMs, resolveStepStartTimestamp(message));
    }

    const terminalAt =
      messageTime(message, 'completed', 'end', 'ended', 'updated', 'created') ?? messageActivityAt(message);

    if (status === 'error' && terminalAt) {
      errorAtMs = maxTimestamp(errorAtMs, terminalAt);
      continue;
    }

    const hasDoneSignal = status === 'done' && (type === 'session.status' || type === 'completed');
    if (hasDoneSignal && terminalAt) {
      completedAtMs = maxTimestamp(completedAtMs, terminalAt);
      continue;
    }

    const ambiguousStatus = resolveAmbiguousStepFinishStatus(message);
    if (ambiguousStatus === 'error' && terminalAt) {
      ambiguousErrorAtMs = maxTimestamp(ambiguousErrorAtMs, terminalAt);
      continue;
    }

    if (ambiguousStatus === 'done' && terminalAt) {
      ambiguousCompletedAtMs = maxTimestamp(ambiguousCompletedAtMs, terminalAt);
    }
  }

  const ambiguousAtMs = Math.max(ambiguousCompletedAtMs, ambiguousErrorAtMs);
  const ambiguousStatus = ambiguousErrorAtMs > ambiguousCompletedAtMs ? 'error' : 'done';
  const summary: MessageSummary =
    errorAtMs > completedAtMs
      ? { status: 'error', endedAt: latestISOString(errorAtMs) }
      : completedAtMs > 0
        ? { status: 'done', endedAt: latestISOString(completedAtMs) }
        : ambiguousAtMs > 0 && ambiguousAtMs >= latestStepStartAtMs
          ? { status: ambiguousStatus, endedAt: latestISOString(ambiguousAtMs), evidence: 'ambiguous' }
          : {};

  return {
    summary,
    latestActivityAt: latestISOString(latestActivityMs),
    latestLiveActivityAt: latestISOString(latestLiveActivityMs),
  };
};

const readTuiMessageActivity = (api: TuiPluginApi, sessionId: string): MessageActivity => {
  try {
    return analyzeMessages(api.state.session.messages(sessionId));
  } catch {
    return emptyMessageActivity();
  }
};

const createTuiMessageActivityCache = (api: TuiPluginApi): ((sessionId: string) => MessageActivity) => {
  const cache = new Map<string, MessageActivity>();

  return (sessionId: string): MessageActivity => {
    const cached = cache.get(sessionId);
    if (cached) return cached;

    const activity = readTuiMessageActivity(api, sessionId);
    cache.set(sessionId, activity);
    return activity;
  };
};

export const latestSessionActivityAt = (api: TuiPluginApi, sessionId: string): string | undefined => {
  return readTuiMessageActivity(api, sessionId).latestActivityAt;
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

export const summarizeMessages = (messages: readonly unknown[]): MessageSummary => analyzeMessages(messages).summary;

const groupTargetRowsBySessionID = (
  state: SubagentState,
  targetSessionIDSet: ReadonlySet<string>,
): Map<string, SubagentChild[]> => {
  const groups = new Map<string, SubagentChild[]>();

  for (const child of Object.values(state.children)) {
    if (!isRealSessionRow(child)) continue;

    const sessionId = resolveSessionRowSessionId(child);
    if (!sessionId || !targetSessionIDSet.has(sessionId)) continue;

    const group = groups.get(sessionId);
    if (group) {
      group.push(child);
    } else {
      groups.set(sessionId, [child]);
    }
  }

  return groups;
};

/**
 * Shared per-session hydration logic.
 *
 * Determines whether a set of children targeting the same session should be
 * marked running or terminal based on the session status and message activity.
 * Returns true if any child state was modified.
 *
 * Callers (wrapper functions) are responsible for reading the session status
 * and message activity according to their source (client API vs TUI state),
 * and for handling any source-specific special cases (e.g. TUI error early
 * path, client running timestamp enrichment).
 */
const hydrateChildFromSessionActivity = (
  sessionId: string,
  children: SubagentChild[],
  sessionStatus: unknown,
  messageActivity: MessageActivity,
  state: SubagentState,
  runningEvidenceIDs: RunningEvidenceCollector | undefined,
  options: StatusHydrationOptions | undefined,
): boolean => {
  const status = deriveSessionStatus(sessionStatus);
  const terminalStatus = deriveTerminalSessionStatus(sessionStatus);
  const blockRunningEvidence = isRecoveryProtectedFromRunning(sessionId, options);

  // Running path
  if (status === 'running') {
    if (blockRunningEvidence) return false;

    runningEvidenceIDs?.add(sessionId);
    let changed = false;
    for (const child of children) {
      changed = markChildRunning(state, child.id, messageActivity.latestLiveActivityAt ?? child.updatedAt) || changed;
    }
    return changed;
  }

  // Terminal / validation path
  const nextStatus = terminalStatus ?? messageActivity.summary.status;
  if (nextStatus) {
    if (!terminalStatus && messageActivity.summary.evidence === 'ambiguous' && runningEvidenceIDs?.has(sessionId)) {
      return false;
    }

    let changed = false;
    for (const child of children) {
      const endedAt =
        sessionStatusEndedAt(sessionStatus) ??
        messageActivity.summary.endedAt ??
        messageActivity.latestActivityAt ??
        child.endedAt ??
        child.updatedAt;
      changed = markChildStatus(state, child.id, nextStatus, endedAt) || changed;
    }
    return changed;
  }

  // No terminal status — check for running evidence from newer activity
  if (blockRunningEvidence) return false;

  let changed = false;
  for (const child of children) {
    if (!isNewerTimestamp(messageActivity.latestLiveActivityAt, child.updatedAt)) continue;

    runningEvidenceIDs?.add(sessionId);
    changed = markChildRunning(state, child.id, messageActivity.latestLiveActivityAt) || changed;
  }
  return changed;
};

export const hydrateChildStatusesFromClient = async (
  api: TuiPluginApi,
  state: SubagentState,
  targetSessionIDs: readonly string[],
  runningEvidenceSessionIDs?: RunningEvidenceCollector,
  options?: StatusHydrationOptions,
): Promise<boolean> => {
  if (targetSessionIDs.length === 0) return false;

  const sessionClient = createSessionClientBoundary(api);
  const targetSessionIDSet = new Set(targetSessionIDs);

  const targetsBySessionID = groupTargetRowsBySessionID(state, targetSessionIDSet);
  if (targetsBySessionID.size === 0) return false;

  let statusBySessionID: Record<string, unknown> = {};

  try {
    statusBySessionID = await sessionClient.readStatusMap();
  } catch {
    statusBySessionID = {};
  }

  let changed = false;
  const getTuiMessageActivity = createTuiMessageActivityCache(api);

  await Promise.all(
    [...targetsBySessionID.entries()].map(async ([sessionId, children]) => {
      const clientSessionStatus = statusBySessionID[sessionId];
      const clientStatus = deriveSessionStatus(clientSessionStatus);
      const blockRunningEvidence = isRecoveryProtectedFromRunning(sessionId, options);
      const clientTerminalStatus = deriveTerminalSessionStatus(clientSessionStatus);

      // Running path — client-specific: enriches timestamp with TUI live activity fallback
      if (clientStatus === 'running') {
        if (blockRunningEvidence) {
          debugLog(`[subagent-status] hydration-client: ${sessionId} protected from running (recovery terminal)`);
          return;
        }

        let clientActivity = emptyMessageActivity();

        try {
          clientActivity = analyzeMessages(await sessionClient.readMessages(sessionId));
        } catch {
          clientActivity = emptyMessageActivity();
        }

        const latestActivityAt =
          clientActivity.latestLiveActivityAt ?? getTuiMessageActivity(sessionId).latestLiveActivityAt;

        runningEvidenceSessionIDs?.add(sessionId);
        for (const child of children) {
          changed = markChildRunning(state, child.id, latestActivityAt ?? child.updatedAt) || changed;
        }

        return;
      }

      // Non-running — read client messages and build activity
      let clientActivity = emptyMessageActivity();

      try {
        clientActivity = analyzeMessages(await sessionClient.readMessages(sessionId));
      } catch {
        clientActivity = emptyMessageActivity();
      }

      const nextStatus = clientTerminalStatus ?? clientActivity.summary.status;
      debugLog(
        `[subagent-status] hydration-client: ${sessionId} clientStatus=${clientStatus} clientTerminal=${clientTerminalStatus} nextStatus=${nextStatus}`,
      );

      // Enrich latestActivityAt with TUI fallback (for terminal path endedAt)
      // latestLiveActivityAt is NOT enriched (no-status running evidence uses client-only timestamps)
      const tuiActivity = getTuiMessageActivity(sessionId);
      const enrichedActivity: MessageActivity = {
        summary: clientActivity.summary,
        latestActivityAt: clientActivity.latestActivityAt ?? tuiActivity.latestActivityAt,
        latestLiveActivityAt: clientActivity.latestLiveActivityAt,
      };

      // Delegate all non-running paths (no-status running evidence, terminal, ambiguous guard) to shared function
      changed =
        hydrateChildFromSessionActivity(
          sessionId,
          children,
          clientSessionStatus,
          enrichedActivity,
          state,
          runningEvidenceSessionIDs,
          options,
        ) || changed;
    }),
  );

  if (changed) state.updatedAt = new Date().toISOString();

  return changed;
};

export const hydrateChildStatusesFromTuiState = (
  api: TuiPluginApi,
  state: SubagentState,
  targetSessionIDs: readonly string[],
  runningEvidenceSessionIDs?: RunningEvidenceCollector,
  options?: StatusHydrationOptions,
): boolean => {
  if (targetSessionIDs.length === 0) return false;

  const targetSessionIDSet = new Set(targetSessionIDs);
  const targetsBySessionID = groupTargetRowsBySessionID(state, targetSessionIDSet);
  const getTuiMessageActivity = createTuiMessageActivityCache(api);
  let changed = false;

  for (const [sessionId, children] of targetsBySessionID) {
    const sessionStatus = api.state.session.status(sessionId);

    // TUI-specific early error path: uses latestLiveActivityAt for endedAt
    // (different from the standard endedAt chain used by the shared function)
    if (deriveSessionStatus(sessionStatus) === 'error') {
      const blockRunningEvidence = isRecoveryProtectedFromRunning(sessionId, options);
      if (blockRunningEvidence) continue;

      const latestActivityAt = getTuiMessageActivity(sessionId).latestLiveActivityAt;
      for (const child of children) {
        const endedAt = latestActivityAt ?? child.endedAt ?? child.updatedAt;
        changed = markChildStatus(state, child.id, 'error', endedAt) || changed;
      }
      continue;
    }

    // All other paths (running, terminal from messages, running evidence) handled by shared logic
    const messageActivity = getTuiMessageActivity(sessionId);
    changed =
      hydrateChildFromSessionActivity(
        sessionId,
        children,
        sessionStatus,
        messageActivity,
        state,
        runningEvidenceSessionIDs,
        options,
      ) || changed;
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
