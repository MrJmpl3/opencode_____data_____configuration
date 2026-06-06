import type { SubagentState } from '../domain/types.ts';

import type { StaleRunningProbePolicy } from './options.ts';
import { isRealSessionRow, resolveSessionRowSessionID } from './session-row.ts';

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
  probeStateBySessionID: Map<string, StaleRunningProbeState>,
  policy: StaleRunningProbePolicy,
  nowMs: number,
): string[] {
  const activeRunningSessionIDs = new Set<string>();
  const targetSessionIDs: string[] = [];

  for (const child of Object.values(state.children)) {
    if (!isRealSessionRow(child) || child.status !== 'running') continue;

    const sessionID = resolveSessionRowSessionID(child);
    if (!sessionID) continue;

    activeRunningSessionIDs.add(sessionID);
    const existing = probeStateBySessionID.get(sessionID);

    if (!existing) {
      targetSessionIDs.push(sessionID);
      continue;
    }

    if (existing.lastSeenUpdatedAt !== child.updatedAt) {
      probeStateBySessionID.set(sessionID, {
        attempts: 0,
        lastSeenUpdatedAt: child.updatedAt,
        nextProbeAtMs: nowMs + policy.baseBackoffMs,
      });
      continue;
    }

    if (existing.attempts >= policy.maxAttempts) continue;
    if (nowMs < existing.nextProbeAtMs) continue;
    targetSessionIDs.push(sessionID);
  }

  for (const sessionID of [...probeStateBySessionID.keys()]) {
    if (!activeRunningSessionIDs.has(sessionID)) {
      probeStateBySessionID.delete(sessionID);
    }
  }

  return targetSessionIDs;
}

export function settleStaleRunningProbeTargets(
  state: SubagentState,
  probeStateBySessionID: Map<string, StaleRunningProbeState>,
  sessionIDs: string[],
  policy: StaleRunningProbePolicy,
  nowMs: number,
): void {
  for (const sessionID of sessionIDs) {
    const child = Object.values(state.children).find(
      (candidate) => isRealSessionRow(candidate) && resolveSessionRowSessionID(candidate) === sessionID,
    );

    if (!child || child.status !== 'running') {
      probeStateBySessionID.delete(sessionID);
      continue;
    }

    const previous = probeStateBySessionID.get(sessionID);
    if (!previous || previous.lastSeenUpdatedAt !== child.updatedAt) {
      const attempts = 1;
      probeStateBySessionID.set(sessionID, {
        attempts,
        lastSeenUpdatedAt: child.updatedAt,
        nextProbeAtMs: nowMs + nextStaleRunningBackoffMs(attempts, policy),
      });
      continue;
    }

    const attempts = previous.attempts + 1;
    probeStateBySessionID.set(sessionID, {
      attempts,
      lastSeenUpdatedAt: child.updatedAt,
      nextProbeAtMs: nowMs + nextStaleRunningBackoffMs(attempts, policy),
    });
  }
}
