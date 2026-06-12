import { describe, expect, it } from 'vitest';

import { createEmptyState } from '../src/domain/state.ts';
import type { SubagentState } from '../src/domain/types.ts';
import { resolveSubagentStatusPluginOptions } from '../src/runtime/options.ts';
import type { StaleRunningProbeState } from '../src/runtime/stale-probe.ts';
import {
  nextStaleRunningBackoffMs,
  resolveStaleRunningProbeTargets,
  settleStaleRunningProbeTargets,
} from '../src/runtime/stale-probe.ts';

const runningState = (children: SubagentState['children']): SubagentState => {
  return {
    ...createEmptyState(),
    children,
  };
};

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
    settleStaleRunningProbeTargets(state, probeState, firstTargets, new Set(['ses_child']), new Set(), policy, 1_000);
    expect(probeState.get('ses_child')).toMatchObject({
      attempts: 1,
      missingRunningEvidenceAttempts: 0,
      lastSeenUpdatedAt: '2026-06-04T11:59:00.000Z',
    });

    state.children.ses_child.updatedAt = '2026-06-04T12:01:00.000Z';
    expect(resolveStaleRunningProbeTargets(state, probeState, policy, 1_500)).toEqual([]);
    expect(probeState.get('ses_child')).toMatchObject({
      attempts: 0,
      missingRunningEvidenceAttempts: 0,
      lastSeenUpdatedAt: '2026-06-04T12:01:00.000Z',
    });

    state.children.ses_child.status = 'done';
    expect(resolveStaleRunningProbeTargets(state, probeState, policy, 2_000)).toEqual([]);
    expect(probeState.has('ses_child')).toBe(false);
  });

  it('caps exponential backoff and marks absent legacy running sessions error once probes are exhausted', () => {
    const probeState = new Map();
    const baseNowMs = Date.parse('2026-06-04T12:00:00.000Z');
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

    let nowMs = baseNowMs;
    let targets = resolveStaleRunningProbeTargets(state, probeState, policy, nowMs);
    expect(targets).toEqual(['ses_child']);
    settleStaleRunningProbeTargets(state, probeState, targets, new Set(), new Set(), policy, nowMs);
    expect(probeState.get('ses_child')).toMatchObject({
      attempts: 1,
      missingRunningEvidenceAttempts: 1,
      nextProbeAtMs: baseNowMs + 1_000,
    });

    nowMs = baseNowMs + 999;
    expect(resolveStaleRunningProbeTargets(state, probeState, policy, nowMs)).toEqual([]);

    nowMs = baseNowMs + 1_000;
    targets = resolveStaleRunningProbeTargets(state, probeState, policy, nowMs);
    expect(targets).toEqual(['ses_child']);
    settleStaleRunningProbeTargets(state, probeState, targets, new Set(), new Set(), policy, nowMs);
    expect(probeState.get('ses_child')).toMatchObject({
      attempts: 2,
      missingRunningEvidenceAttempts: 2,
      nextProbeAtMs: baseNowMs + 3_000,
    });

    nowMs = baseNowMs + 3_000;
    targets = resolveStaleRunningProbeTargets(state, probeState, policy, nowMs);
    expect(targets).toEqual(['ses_child']);
    expect(settleStaleRunningProbeTargets(state, probeState, targets, new Set(), new Set(), policy, nowMs)).toBe(true);
    expect(probeState.has('ses_child')).toBe(false);
    expect(state.children.ses_child).toMatchObject({
      status: 'error',
      endedAt: '2026-06-04T12:00:03.000Z',
      updatedAt: '2026-06-04T12:00:03.000Z',
    });

    expect(resolveStaleRunningProbeTargets(state, probeState, policy, baseNowMs + 8_000)).toEqual([]);
  });

  it('does not accumulate missing running evidence attempts while running evidence still exists', () => {
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

    let targets = resolveStaleRunningProbeTargets(state, probeState, policy, 1_000);
    settleStaleRunningProbeTargets(state, probeState, targets, new Set(), new Set(['ses_child']), policy, 1_000);

    targets = resolveStaleRunningProbeTargets(state, probeState, policy, 2_000);
    settleStaleRunningProbeTargets(state, probeState, targets, new Set(), new Set(['ses_child']), policy, 2_000);

    expect(state.children.ses_child).toMatchObject({ status: 'running' });
    expect(probeState.get('ses_child')).toMatchObject({
      attempts: 2,
      missingRunningEvidenceAttempts: 0,
    });
  });

  it('keeps authoritative running sessions alive when status and messages are inconclusive past max attempts', () => {
    const probeState = new Map();
    const baseNowMs = Date.parse('2026-06-04T12:00:00.000Z');
    const policy = resolveSubagentStatusPluginOptions({
      staleRunningProbePolicy: { baseBackoffMs: 1_000, maxBackoffMs: 4_000, maxAttempts: 2 },
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

    let nowMs = baseNowMs;
    let targets = resolveStaleRunningProbeTargets(state, probeState, policy, nowMs);
    expect(targets).toEqual(['ses_child']);
    settleStaleRunningProbeTargets(state, probeState, targets, new Set(['ses_child']), new Set(), policy, nowMs);
    expect(probeState.get('ses_child')).toMatchObject({
      attempts: 1,
      missingRunningEvidenceAttempts: 0,
    });

    nowMs = baseNowMs + 1_000;
    targets = resolveStaleRunningProbeTargets(state, probeState, policy, nowMs);
    expect(targets).toEqual(['ses_child']);
    const changed = settleStaleRunningProbeTargets(
      state,
      probeState,
      targets,
      new Set(['ses_child']),
      new Set(),
      policy,
      nowMs,
    );

    expect(changed).toBe(false);
    expect(probeState.get('ses_child')).toMatchObject({
      attempts: 2,
      missingRunningEvidenceAttempts: 0,
    });
    expect(state.children.ses_child).toMatchObject({
      status: 'running',
      updatedAt: '2026-06-04T11:59:00.000Z',
    });

    nowMs = baseNowMs + 3_000;
    targets = resolveStaleRunningProbeTargets(state, probeState, policy, nowMs);
    expect(targets).toEqual(['ses_child']);

    expect(settleStaleRunningProbeTargets(state, probeState, targets, new Set(), new Set(), policy, nowMs)).toBe(false);
    expect(state.children.ses_child).toMatchObject({ status: 'running' });
    expect(probeState.get('ses_child')).toMatchObject({
      attempts: 2,
      missingRunningEvidenceAttempts: 1,
    });
  });

  it('marks authoritative running sessions error after the hard stale safety-net expires', () => {
    const probeState = new Map();
    const nowMs = Date.parse('2026-06-04T12:00:00.000Z');
    const policy = resolveSubagentStatusPluginOptions({
      staleRunningProbePolicy: {
        baseBackoffMs: 1_000,
        hardStaleAfterMs: 60_000,
        maxBackoffMs: 4_000,
        maxAttempts: 100,
      },
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

    const targets = resolveStaleRunningProbeTargets(state, probeState, policy, nowMs);
    const changed = settleStaleRunningProbeTargets(
      state,
      probeState,
      targets,
      new Set(['ses_child']),
      new Set(),
      policy,
      nowMs,
    );

    expect(changed).toBe(true);
    expect(probeState.has('ses_child')).toBe(false);
    expect(state.children.ses_child).toMatchObject({
      status: 'error',
      endedAt: '2026-06-04T12:00:00.000Z',
      updatedAt: '2026-06-04T12:00:00.000Z',
    });
  });

  it('marks hard-stale-aged sessions error even when stale direct running evidence exists', () => {
    const probeState = new Map();
    const nowMs = Date.parse('2026-06-04T12:00:00.000Z');
    const policy = resolveSubagentStatusPluginOptions({
      staleRunningProbePolicy: {
        baseBackoffMs: 1_000,
        hardStaleAfterMs: 60_000,
        maxBackoffMs: 4_000,
        maxAttempts: 100,
      },
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

    const targets = resolveStaleRunningProbeTargets(state, probeState, policy, nowMs);
    const changed = settleStaleRunningProbeTargets(
      state,
      probeState,
      targets,
      new Set(['ses_child']),
      new Set(['ses_child']),
      policy,
      nowMs,
    );

    expect(changed).toBe(true);
    expect(probeState.has('ses_child')).toBe(false);
    expect(state.children.ses_child).toMatchObject({
      status: 'error',
      endedAt: '2026-06-04T12:00:00.000Z',
      updatedAt: '2026-06-04T12:00:00.000Z',
    });
  });

  it('keeps fresh direct running evidence below the hard stale threshold running', () => {
    const probeState = new Map();
    const nowMs = Date.parse('2026-06-04T12:00:00.000Z');
    const policy = resolveSubagentStatusPluginOptions({
      staleRunningProbePolicy: {
        baseBackoffMs: 1_000,
        hardStaleAfterMs: 60_000,
        maxBackoffMs: 4_000,
        maxAttempts: 100,
      },
    }).staleRunningProbePolicy;
    const state = runningState({
      ses_child: {
        id: 'ses_child',
        title: 'Real session',
        parentID: 'ses_parent',
        source: 'session',
        status: 'running',
        startedAt: '2026-06-04T11:55:00.000Z',
        updatedAt: '2026-06-04T11:59:30.000Z',
      },
    });

    const targets = resolveStaleRunningProbeTargets(state, probeState, policy, nowMs);
    const changed = settleStaleRunningProbeTargets(
      state,
      probeState,
      targets,
      new Set(['ses_child']),
      new Set(['ses_child']),
      policy,
      nowMs,
    );

    expect(changed).toBe(false);
    expect(state.children.ses_child).toMatchObject({
      status: 'running',
      updatedAt: '2026-06-04T11:59:30.000Z',
    });
    expect(probeState.get('ses_child')).toMatchObject({ attempts: 1, missingRunningEvidenceAttempts: 0 });
  });

  it('marks authoritative-omitted sessions error only after consecutive absent no-evidence probes', () => {
    const probeState = new Map();
    const baseNowMs = Date.parse('2026-06-04T12:00:00.000Z');
    const policy = resolveSubagentStatusPluginOptions({
      staleRunningProbePolicy: { baseBackoffMs: 1_000, maxBackoffMs: 4_000, maxAttempts: 2 },
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

    let nowMs = baseNowMs;
    let targets = resolveStaleRunningProbeTargets(state, probeState, policy, nowMs);
    settleStaleRunningProbeTargets(state, probeState, targets, new Set(['ses_child']), new Set(), policy, nowMs);

    nowMs = baseNowMs + 1_000;
    targets = resolveStaleRunningProbeTargets(state, probeState, policy, nowMs);
    settleStaleRunningProbeTargets(state, probeState, targets, new Set(['ses_child']), new Set(), policy, nowMs);

    expect(probeState.get('ses_child')).toMatchObject({ missingRunningEvidenceAttempts: 0 });

    nowMs = baseNowMs + 3_000;
    targets = resolveStaleRunningProbeTargets(state, probeState, policy, nowMs);
    expect(settleStaleRunningProbeTargets(state, probeState, targets, new Set(), new Set(), policy, nowMs)).toBe(false);
    expect(state.children.ses_child).toMatchObject({ status: 'running' });
    expect(probeState.get('ses_child')).toMatchObject({ missingRunningEvidenceAttempts: 1 });

    nowMs = baseNowMs + 5_000;
    targets = resolveStaleRunningProbeTargets(state, probeState, policy, nowMs);
    expect(settleStaleRunningProbeTargets(state, probeState, targets, new Set(), new Set(), policy, nowMs)).toBe(true);
    expect(state.children.ses_child).toMatchObject({ status: 'error' });
  });

  it('normalizes old-shaped probe state without producing NaN', () => {
    const baseNowMs = Date.parse('2026-06-04T12:00:00.000Z');
    const probeState = new Map<string, StaleRunningProbeState>([
      [
        'ses_child',
        {
          attempts: 1,
          missingAuthoritativeAttempts: 1,
          lastSeenUpdatedAt: '2026-06-04T11:59:00.000Z',
          nextProbeAtMs: baseNowMs,
        } as unknown as StaleRunningProbeState,
      ],
    ]);
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

    const targets = resolveStaleRunningProbeTargets(state, probeState, policy, baseNowMs);
    const changed = settleStaleRunningProbeTargets(state, probeState, targets, new Set(), new Set(), policy, baseNowMs);
    const nextProbeState = probeState.get('ses_child');

    expect(changed).toBe(false);
    expect(state.children.ses_child).toMatchObject({ status: 'running' });
    expect(nextProbeState).toMatchObject({ attempts: 2, missingRunningEvidenceAttempts: 2 });
    expect(Number.isFinite(nextProbeState?.attempts)).toBe(true);
    expect(Number.isFinite(nextProbeState?.missingRunningEvidenceAttempts)).toBe(true);
  });

  it('handles maxAttempts 0 without producing NaN', () => {
    const probeState = new Map();
    const nowMs = Date.parse('2026-06-04T12:00:00.000Z');
    const policy = resolveSubagentStatusPluginOptions({
      staleRunningProbePolicy: { baseBackoffMs: 1_000, maxBackoffMs: 4_000, maxAttempts: 0 },
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

    const targets = resolveStaleRunningProbeTargets(state, probeState, policy, nowMs);
    expect(
      settleStaleRunningProbeTargets(state, probeState, targets, new Set(['ses_child']), new Set(), policy, nowMs),
    ).toBe(false);
    expect(probeState.get('ses_child')).toMatchObject({ attempts: 0, missingRunningEvidenceAttempts: 0 });
    expect(Number.isFinite(probeState.get('ses_child')?.attempts)).toBe(true);
    expect(Number.isFinite(probeState.get('ses_child')?.missingRunningEvidenceAttempts)).toBe(true);

    expect(
      settleStaleRunningProbeTargets(state, probeState, targets, new Set(), new Set(), policy, nowMs + 1_000),
    ).toBe(true);
    expect(state.children.ses_child).toMatchObject({ status: 'error' });
  });

  it('keeps maxAttempts 0 sessions running when direct running evidence exists without authoritative presence', () => {
    const probeState = new Map();
    const nowMs = Date.parse('2026-06-04T12:00:00.000Z');
    const policy = resolveSubagentStatusPluginOptions({
      staleRunningProbePolicy: { baseBackoffMs: 1_000, maxBackoffMs: 4_000, maxAttempts: 0 },
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

    const targets = resolveStaleRunningProbeTargets(state, probeState, policy, nowMs);
    const changed = settleStaleRunningProbeTargets(
      state,
      probeState,
      targets,
      new Set(),
      new Set(['ses_child']),
      policy,
      nowMs,
    );

    expect(changed).toBe(false);
    expect(state.children.ses_child).toMatchObject({
      status: 'running',
      updatedAt: '2026-06-04T11:59:00.000Z',
    });
    expect(state.children.ses_child).not.toHaveProperty('endedAt');
    expect(probeState.get('ses_child')).toMatchObject({ attempts: 0, missingRunningEvidenceAttempts: 0 });
    expect(probeState.has('ses_child')).toBe(true);
  });

  it('uses a monotonic error timestamp when the child evidence timestamp is in the future', () => {
    const probeState = new Map();
    const nowMs = Date.parse('2026-06-04T12:00:00.000Z');
    const futureUpdatedAt = '2026-06-04T12:05:00.000Z';
    const policy = resolveSubagentStatusPluginOptions({
      staleRunningProbePolicy: { baseBackoffMs: 1_000, maxBackoffMs: 4_000, maxAttempts: 1 },
    }).staleRunningProbePolicy;
    const state = runningState({
      ses_child: {
        id: 'ses_child',
        title: 'Real session',
        parentID: 'ses_parent',
        source: 'session',
        status: 'running',
        startedAt: '2026-06-04T11:55:00.000Z',
        updatedAt: futureUpdatedAt,
      },
    });

    const targets = resolveStaleRunningProbeTargets(state, probeState, policy, nowMs);
    const changed = settleStaleRunningProbeTargets(state, probeState, targets, new Set(), new Set(), policy, nowMs);

    expect(changed).toBe(true);
    expect(probeState.has('ses_child')).toBe(false);
    expect(state.children.ses_child).toMatchObject({
      status: 'error',
      endedAt: futureUpdatedAt,
      updatedAt: futureUpdatedAt,
    });
  });

  it('does not error a child when missing running evidence briefly reappears before attempts are exhausted', () => {
    const probeState = new Map();
    const baseNowMs = Date.parse('2026-06-04T12:00:00.000Z');
    const policy = resolveSubagentStatusPluginOptions({
      staleRunningProbePolicy: { baseBackoffMs: 1_000, maxBackoffMs: 4_000, maxAttempts: 2 },
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

    let nowMs = baseNowMs;
    let targets = resolveStaleRunningProbeTargets(state, probeState, policy, nowMs);
    settleStaleRunningProbeTargets(state, probeState, targets, new Set(), new Set(), policy, nowMs);
    expect(probeState.get('ses_child')).toMatchObject({ missingRunningEvidenceAttempts: 1 });

    nowMs = baseNowMs + 1_000;
    targets = resolveStaleRunningProbeTargets(state, probeState, policy, nowMs);
    settleStaleRunningProbeTargets(state, probeState, targets, new Set(), new Set(['ses_child']), policy, nowMs);
    expect(probeState.get('ses_child')).toMatchObject({ missingRunningEvidenceAttempts: 0 });

    nowMs = baseNowMs + 3_000;
    targets = resolveStaleRunningProbeTargets(state, probeState, policy, nowMs);
    const changed = settleStaleRunningProbeTargets(state, probeState, targets, new Set(), new Set(), policy, nowMs);

    expect(changed).toBe(false);
    expect(state.children.ses_child).toMatchObject({ status: 'running' });
    expect(probeState.get('ses_child')).toMatchObject({ missingRunningEvidenceAttempts: 1 });
  });
});
