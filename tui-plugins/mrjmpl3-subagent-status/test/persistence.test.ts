import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RecoveryContext, RecoverySource } from '../src/infrastructure/recovery.ts';
import type { SubagentState } from '../src/domain/types.ts';
import { createPersistQueue, loadState, saveState } from '../src/infrastructure/persistence.ts';

describe('persistence recovery', () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-04T12:05:00.000Z'));
  });

  afterEach(async () => {
    vi.useRealTimers();

    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('applies recovery sources while keeping the persisted state format readable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mrjmpl3-subagent-status-'));
    tempDirs.push(dir);
    const statePath = join(dir, 'state.json');

    await saveState(statePath, {
      children: {
        ses_child: {
          id: 'ses_child',
          title: 'Legacy child',
          parentID: 'ses_parent',
          source: 'session',
          status: 'running',
          startedAt: '2026-06-04T11:55:00.000Z',
          updatedAt: '2026-06-04T11:59:00.000Z',
        },
      },
      countedChildIDs: { ses_child: true },
      purgedSessionIDs: {},
      totalExecuted: 1,
      updatedAt: '2026-06-04T11:59:00.000Z',
    } as SubagentState);

    const recoverySource: RecoverySource = {
      async hydrateState(state: SubagentState, _context: RecoveryContext) {
        state.children.ses_child = {
          ...state.children.ses_child,
          status: 'done',
          updatedAt: '2026-06-04T12:00:00.000Z',
          endedAt: '2026-06-04T12:00:00.000Z',
          tokens: { input: 8, output: 5, total: 13 },
        };

        return {
          changed: true,
          authoritativeSessionIDs: ['ses_child'],
        };
      },
    };

    const loaded = await loadState(statePath, {
      recoveryContext: { directory: '/tmp/workspace', parentSessionID: 'ses_parent' },
      recoverySources: [recoverySource],
    });

    expect(loaded.children.ses_child).toMatchObject({
      status: 'done',
      endedAt: '2026-06-04T12:00:00.000Z',
      tokens: { input: 8, output: 5, total: 13 },
    });
    expect(loaded.totalExecuted).toBe(1);
  });

  it('keeps purged stale sessions absent after recovery removes them on load', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mrjmpl3-subagent-status-'));
    tempDirs.push(dir);
    const statePath = join(dir, 'state.json');

    await saveState(statePath, {
      children: {
        ses_stale: {
          id: 'ses_stale',
          title: 'Stale child',
          parentID: 'ses_parent',
          source: 'session',
          status: 'running',
          startedAt: '2026-06-04T11:40:00.000Z',
          updatedAt: '2026-06-04T11:59:00.000Z',
        },
      },
      countedChildIDs: { ses_stale: true },
      purgedSessionIDs: {},
      totalExecuted: 1,
      updatedAt: '2026-06-04T11:59:00.000Z',
    } as SubagentState);

    const recoverySource: RecoverySource = {
      async hydrateState(state: SubagentState) {
        delete state.children.ses_stale;
        state.purgedSessionIDs.ses_stale = true;

        return {
          changed: true,
          authoritativeSessionIDs: [],
        };
      },
    };

    const loaded = await loadState(statePath, {
      recoveryContext: { directory: '/tmp/workspace', parentSessionID: 'ses_parent' },
      recoverySources: [recoverySource],
    });

    expect(loaded.children.ses_stale).toBeUndefined();
    expect(loaded.purgedSessionIDs.ses_stale).toBe(true);
  });

  it('clones state snapshots at enqueue time before later mutations', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mrjmpl3-subagent-status-'));
    tempDirs.push(dir);
    const statePath = join(dir, 'state.json');
    const textPath = join(dir, 'status.txt');
    const state: SubagentState = {
      children: {
        ses_original: {
          id: 'ses_original',
          title: 'Original child',
          parentID: 'ses_parent',
          source: 'session',
          status: 'running',
          startedAt: '2026-06-04T11:55:00.000Z',
          updatedAt: '2026-06-04T11:59:00.000Z',
        },
      },
      countedChildIDs: { ses_original: true },
      purgedSessionIDs: {},
      totalExecuted: 1,
      updatedAt: '2026-06-04T11:59:00.000Z',
    };

    const persist = createPersistQueue(statePath, textPath, (snapshot, meta: { source: string }) => ({
      statusText: `${meta.source}:${Object.keys(snapshot.children).join(',')}`,
      debugSnapshot: JSON.stringify({ source: meta.source, childIDs: Object.keys(snapshot.children) }),
    }));

    const write = persist(state, { source: 'refresh' });
    state.children.ses_mutated = {
      id: 'ses_mutated',
      title: 'Mutated child',
      parentID: 'ses_parent',
      source: 'session',
      status: 'running',
      startedAt: '2026-06-04T11:56:00.000Z',
      updatedAt: '2026-06-04T12:00:00.000Z',
    };

    await write;

    const loaded = await loadState(statePath);
    expect(Object.keys(loaded.children)).toEqual(['ses_original']);
  });
});
