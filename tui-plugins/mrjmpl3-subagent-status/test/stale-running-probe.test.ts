import { describe, expect, it } from 'vitest';

import { createEmptyState } from '../src/domain/state.ts';
import type { SubagentState } from '../src/domain/types.ts';
import { resolveSubagentStatusPluginOptions } from '../src/runtime/options.ts';
import {
  nextStaleRunningBackoffMs,
  resolveStaleRunningProbeTargets,
  settleStaleRunningProbeTargets,
} from '../src/runtime/stale-probe.ts';

function runningState(children: SubagentState['children']): SubagentState {
  return {
    ...createEmptyState(),
    children,
  };
}

describe('stale running probe helpers', () => {
  it('targets only real running session rows', () => {
    const probeState = new Map();
    const state = runningState({
      'tool:delegate_1': {
        id: 'tool:delegate_1',
        title: 'Wrapper',
        parentID: 'ses_parent',
        targetSessionID: 'ses_child',
        source: 'tool',
        status: 'running',
        startedAt: '2026-06-04T11:55:00.000Z',
        updatedAt: '2026-06-04T11:59:00.000Z',
      },
      ses_child: {
        id: 'ses_child',
        title: 'Real session',
        parentID: 'ses_parent',
        source: 'session',
        status: 'running',
        startedAt: '2026-06-04T11:55:00.000Z',
        updatedAt: '2026-06-04T11:59:00.000Z',
      },
    });
    const policy = resolveSubagentStatusPluginOptions(undefined).staleRunningProbePolicy;

    expect(resolveStaleRunningProbeTargets(state, probeState, policy, 1_000)).toEqual(['ses_child']);
  });

  it('resets and cleans up probe state based on running row changes', () => {
    const probeState = new Map();
    const policy = resolveSubagentStatusPluginOptions({
      staleRunningProbePolicy: { baseBackoffMs: 1_000, maxBackoffMs: 4_000, maxAttempts: 4 },
    }).staleRunningProbePolicy;
    const state = runningState({
      ses_child: {
        id: 'ses_child',
        title: 'Real session',
        parentID: 'ses_parent',
        source: 'session',
        status: 'running',
        startedAt: '2026-06-04T11:55:00.000Z',
        updatedAt: '2026-06-04T11:59:00.000Z',
      },
    });

    const firstTargets = resolveStaleRunningProbeTargets(state, probeState, policy, 1_000);
    settleStaleRunningProbeTargets(state, probeState, firstTargets, policy, 1_000);
    expect(probeState.get('ses_child')).toMatchObject({ attempts: 1, lastSeenUpdatedAt: '2026-06-04T11:59:00.000Z' });

    state.children.ses_child.updatedAt = '2026-06-04T12:01:00.000Z';
    expect(resolveStaleRunningProbeTargets(state, probeState, policy, 1_500)).toEqual([]);
    expect(probeState.get('ses_child')).toMatchObject({ attempts: 0, lastSeenUpdatedAt: '2026-06-04T12:01:00.000Z' });

    state.children.ses_child.status = 'done';
    expect(resolveStaleRunningProbeTargets(state, probeState, policy, 2_000)).toEqual([]);
    expect(probeState.has('ses_child')).toBe(false);
  });

  it('caps exponential backoff and stops probing once max attempts are exhausted', () => {
    const probeState = new Map();
    const policy = resolveSubagentStatusPluginOptions({
      staleRunningProbePolicy: { baseBackoffMs: 1_000, maxBackoffMs: 4_000, maxAttempts: 3 },
    }).staleRunningProbePolicy;
    const state = runningState({
      ses_child: {
        id: 'ses_child',
        title: 'Real session',
        parentID: 'ses_parent',
        source: 'session',
        status: 'running',
        startedAt: '2026-06-04T11:55:00.000Z',
        updatedAt: '2026-06-04T11:59:00.000Z',
      },
    });

    expect(nextStaleRunningBackoffMs(1, policy)).toBe(1_000);
    expect(nextStaleRunningBackoffMs(2, policy)).toBe(2_000);
    expect(nextStaleRunningBackoffMs(3, policy)).toBe(4_000);
    expect(nextStaleRunningBackoffMs(4, policy)).toBe(4_000);

    let nowMs = 1_000;
    let targets = resolveStaleRunningProbeTargets(state, probeState, policy, nowMs);
    expect(targets).toEqual(['ses_child']);
    settleStaleRunningProbeTargets(state, probeState, targets, policy, nowMs);
    expect(probeState.get('ses_child')).toMatchObject({ attempts: 1, nextProbeAtMs: 2_000 });

    nowMs = 1_999;
    expect(resolveStaleRunningProbeTargets(state, probeState, policy, nowMs)).toEqual([]);

    nowMs = 2_000;
    targets = resolveStaleRunningProbeTargets(state, probeState, policy, nowMs);
    expect(targets).toEqual(['ses_child']);
    settleStaleRunningProbeTargets(state, probeState, targets, policy, nowMs);
    expect(probeState.get('ses_child')).toMatchObject({ attempts: 2, nextProbeAtMs: 4_000 });

    nowMs = 4_000;
    targets = resolveStaleRunningProbeTargets(state, probeState, policy, nowMs);
    expect(targets).toEqual(['ses_child']);
    settleStaleRunningProbeTargets(state, probeState, targets, policy, nowMs);
    expect(probeState.get('ses_child')).toMatchObject({ attempts: 3, nextProbeAtMs: 8_000 });

    expect(resolveStaleRunningProbeTargets(state, probeState, policy, 8_000)).toEqual([]);
  });
});
