import type { SubagentState } from '../domain/types.ts';

import type { StaleRunningProbePolicy } from './options.ts';
import { isRealSessionRow, resolveSessionRowSessionId } from './session-row.ts';
import { childEvidenceTimestampMs, markChildStatus } from '../domain/state.ts';

export type StaleRunningProbeState = {
  attempts: number;
  missingRunningEvidenceAttempts: number;
  lastSeenUpdatedAt: string;
  nextProbeAtMs: number;
};

type LegacyStaleRunningProbeState = StaleRunningProbeState & {
  missingAuthoritativeAttempts?: unknown;
};

const finiteProbeCounter = (value: unknown): number | undefined => {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : undefined;
};

const normalizeProbeCounter = (value: unknown): number => {
  return finiteProbeCounter(value) ?? 0;
};

const previousProbeCounter = (
  previous: StaleRunningProbeState | undefined,
  childUpdatedAt: string,
  key: keyof StaleRunningProbeState,
): number => {
  if (!previous || previous.lastSeenUpdatedAt !== childUpdatedAt) return 0;

  return normalizeProbeCounter(previous[key]);
};

const previousMissingRunningEvidenceAttempts = (
  previous: StaleRunningProbeState | undefined,
  childUpdatedAt: string,
): number => {
  if (!previous || previous.lastSeenUpdatedAt !== childUpdatedAt) return 0;

  const currentAttempts = finiteProbeCounter(previous.missingRunningEvidenceAttempts);
  if (currentAttempts !== undefined) return currentAttempts;

  return normalizeProbeCounter((previous as LegacyStaleRunningProbeState).missingAuthoritativeAttempts);
};

export const nextStaleRunningBackoffMs = (attempts: number, policy: StaleRunningProbePolicy): number => {
  return Math.min(policy.baseBackoffMs * 2 ** Math.max(0, attempts - 1), policy.maxBackoffMs);
};

export const resolveStaleRunningProbeTargets = (
  state: SubagentState,
  probeStateBySessionId: Map<string, StaleRunningProbeState>,
  policy: StaleRunningProbePolicy,
  nowMs: number,
): string[] => {
  const activeRunningSessionIds = new Set<string>();
  const targetSessionIds: string[] = [];

  for (const child of Object.values(state.children)) {
    if (!isRealSessionRow(child) || child.status !== 'running') continue;

    const sessionId = resolveSessionRowSessionId(child);
    if (!sessionId) continue;

    activeRunningSessionIds.add(sessionId);
    const existing = probeStateBySessionId.get(sessionId);

    if (!existing) {
      targetSessionIds.push(sessionId);
      continue;
    }

    if (existing.lastSeenUpdatedAt !== child.updatedAt) {
      probeStateBySessionId.set(sessionId, {
        attempts: 0,
        missingRunningEvidenceAttempts: 0,
        lastSeenUpdatedAt: child.updatedAt,
        nextProbeAtMs: nowMs + policy.baseBackoffMs,
      });
      continue;
    }

    if (nowMs < existing.nextProbeAtMs) continue;
    targetSessionIds.push(sessionId);
  }

  for (const sessionId of [...probeStateBySessionId.keys()]) {
    if (!activeRunningSessionIds.has(sessionId)) {
      probeStateBySessionId.delete(sessionId);
    }
  }

  return targetSessionIds;
};

export const settleStaleRunningProbeTargets = (
  state: SubagentState,
  probeStateBySessionId: Map<string, StaleRunningProbeState>,
  sessionIds: string[],
  authoritativeSessionIDs: ReadonlySet<string>,
  runningEvidenceSessionIDs: ReadonlySet<string>,
  policy: StaleRunningProbePolicy,
  nowMs: number,
): boolean => {
  let changed = false;

  for (const sessionId of sessionIds) {
    const child = Object.values(state.children).find(
      (candidate) => isRealSessionRow(candidate) && resolveSessionRowSessionId(candidate) === sessionId,
    );

    if (!child || child.status !== 'running') {
      probeStateBySessionId.delete(sessionId);
      continue;
    }

    const previous = probeStateBySessionId.get(sessionId);
    const attempts = Math.min(policy.maxAttempts, previousProbeCounter(previous, child.updatedAt, 'attempts') + 1);
    const hasRunningEvidence = runningEvidenceSessionIDs.has(sessionId);
    const hasAuthoritativePresenceGuard = authoritativeSessionIDs.has(sessionId);
    const childEvidenceMs = childEvidenceTimestampMs(child);
    const hasExceededHardStaleAge = policy.hardStaleAfterMs > 0 && nowMs - childEvidenceMs >= policy.hardStaleAfterMs;
    const missingRunningEvidenceAttempts =
      hasRunningEvidence || hasAuthoritativePresenceGuard
        ? 0
        : Math.min(policy.maxAttempts, previousMissingRunningEvidenceAttempts(previous, child.updatedAt) + 1);

    if (
      hasExceededHardStaleAge ||
      (!hasRunningEvidence && !hasAuthoritativePresenceGuard && missingRunningEvidenceAttempts >= policy.maxAttempts)
    ) {
      const errorAt = new Date(Math.max(nowMs, childEvidenceMs)).toISOString();
      const marked = markChildStatus(state, child.id, 'error', errorAt);

      if (marked) {
        probeStateBySessionId.delete(sessionId);
        changed = true;
        continue;
      }
    }

    probeStateBySessionId.set(sessionId, {
      attempts,
      missingRunningEvidenceAttempts,
      lastSeenUpdatedAt: child.updatedAt,
      nextProbeAtMs: nowMs + nextStaleRunningBackoffMs(attempts, policy),
    });
  }

  return changed;
};
