import type { SubagentState } from '../domain/types.ts';

import type { StaleRunningProbePolicy } from './options.ts';
import { isRealSessionRow, resolveSessionRowSessionId } from './session-row.ts';

export type StaleRunningProbeState = {
  attempts: number;
  lastSeenUpdatedAt: string;
  nextProbeAtMs: number;
};

export function nextStaleRunningBackoffMs(attempts: number, policy: StaleRunningProbePolicy): number {
  return Math.min(policy.baseBackoffMs * 2 ** Math.max(0, attempts - 1), policy.maxBackoffMs);
}

export function resolveStaleRunningProbeTargets(
  state: SubagentState,
  probeStateBySessionId: Map<string, StaleRunningProbeState>,
  policy: StaleRunningProbePolicy,
  nowMs: number,
): string[] {
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
        lastSeenUpdatedAt: child.updatedAt,
        nextProbeAtMs: nowMs + policy.baseBackoffMs,
      });
      continue;
    }

    if (existing.attempts >= policy.maxAttempts) continue;
    if (nowMs < existing.nextProbeAtMs) continue;
    targetSessionIds.push(sessionId);
  }

  for (const sessionId of [...probeStateBySessionId.keys()]) {
    if (!activeRunningSessionIds.has(sessionId)) {
      probeStateBySessionId.delete(sessionId);
    }
  }

  return targetSessionIds;
}

export function settleStaleRunningProbeTargets(
  state: SubagentState,
  probeStateBySessionId: Map<string, StaleRunningProbeState>,
  sessionIds: string[],
  policy: StaleRunningProbePolicy,
  nowMs: number,
): void {
  for (const sessionId of sessionIds) {
    const child = Object.values(state.children).find(
      (candidate) => isRealSessionRow(candidate) && resolveSessionRowSessionId(candidate) === sessionId,
    );

    if (!child || child.status !== 'running') {
      probeStateBySessionId.delete(sessionId);
      continue;
    }

    const previous = probeStateBySessionId.get(sessionId);
    if (!previous || previous.lastSeenUpdatedAt !== child.updatedAt) {
      const attempts = 1;
      probeStateBySessionId.set(sessionId, {
        attempts,
        lastSeenUpdatedAt: child.updatedAt,
        nextProbeAtMs: nowMs + nextStaleRunningBackoffMs(attempts, policy),
      });
      continue;
    }

    const attempts = previous.attempts + 1;
    probeStateBySessionId.set(sessionId, {
      attempts,
      lastSeenUpdatedAt: child.updatedAt,
      nextProbeAtMs: nowMs + nextStaleRunningBackoffMs(attempts, policy),
    });
  }
}
