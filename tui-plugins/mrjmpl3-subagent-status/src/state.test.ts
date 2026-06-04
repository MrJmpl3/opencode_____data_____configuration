import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEmptyState, getCounts, loadState, replaceChildren, saveState, upsertRunningChild } from './state.ts';

describe('state', () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-04T12:00:00.000Z'));
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

  it('counts children and persists snapshots', async () => {
    const state = createEmptyState();
    replaceChildren(state, [
      {
        id: 'ses_1',
        title: 'Runner',
        parentID: 'ses_parent',
        status: 'done',
        startedAt: '2026-06-04T11:50:00.000Z',
        updatedAt: '2026-06-04T11:51:00.000Z',
        endedAt: '2026-06-04T11:51:00.000Z',
      },
    ]);

    expect(getCounts(state)).toEqual({ running: 0, done: 1, error: 0 });
    expect(state.totalExecuted).toBe(1);

    const dir = await mkdtemp(join(tmpdir(), 'mrjmpl3-subagent-status-'));
    tempDirs.push(dir);
    const statePath = join(dir, 'state.json');

    await saveState(statePath, state);
    const loaded = await loadState(statePath);

    expect(loaded.totalExecuted).toBe(1);
    expect(getCounts(loaded)).toEqual({ running: 0, done: 1, error: 0 });
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toMatchObject({
      totalExecuted: 1,
    });
  });

  it('does not rewrite identical children snapshots', () => {
    const state = createEmptyState();

    expect(
      replaceChildren(state, [
        {
          id: 'ses_1',
          title: 'Runner',
          parentID: 'ses_parent',
          status: 'done',
          startedAt: '2026-06-04T11:50:00.000Z',
          updatedAt: '2026-06-04T11:51:00.000Z',
          endedAt: '2026-06-04T11:51:00.000Z',
        },
      ]),
    ).toBe(true);

    expect(
      replaceChildren(state, [
        {
          id: 'ses_1',
          title: 'Runner',
          parentID: 'ses_parent',
          status: 'done',
          startedAt: '2026-06-04T11:50:00.000Z',
          updatedAt: '2026-06-04T11:51:00.000Z',
          endedAt: '2026-06-04T11:51:00.000Z',
        },
      ]),
    ).toBe(false);
  });

  it('prunes old terminal children when loading persisted state', async () => {
    const state = createEmptyState();
    state.children = {
      ses_old: {
        id: 'ses_old',
        title: 'Old runner',
        parentID: 'ses_parent',
        status: 'done',
        startedAt: '2026-06-04T10:00:00.000Z',
        updatedAt: '2026-06-04T10:05:00.000Z',
        endedAt: '2026-06-04T10:05:00.000Z',
      },
      ses_recent: {
        id: 'ses_recent',
        title: 'Recent runner',
        parentID: 'ses_parent',
        status: 'done',
        startedAt: '2026-06-04T11:40:00.000Z',
        updatedAt: '2026-06-04T11:45:00.000Z',
        endedAt: '2026-06-04T11:45:00.000Z',
      },
      ses_running: {
        id: 'ses_running',
        title: 'Running runner',
        parentID: 'ses_parent',
        status: 'running',
        startedAt: '2026-06-04T11:55:00.000Z',
        updatedAt: '2026-06-04T11:55:00.000Z',
      },
    };
    state.countedChildIDs = {
      ses_old: true,
      ses_recent: true,
      ses_running: true,
    };
    state.totalExecuted = 3;
    state.updatedAt = '2026-06-04T11:55:00.000Z';

    const dir = await mkdtemp(join(tmpdir(), 'mrjmpl3-subagent-status-'));
    tempDirs.push(dir);
    const statePath = join(dir, 'state.json');

    await saveState(statePath, state);
    const loaded = await loadState(statePath);

    expect(Object.keys(loaded.children)).toEqual(['ses_recent', 'ses_running']);
    expect(loaded.totalExecuted).toBe(3);
    expect(getCounts(loaded)).toEqual({ running: 1, done: 1, error: 0 });
  });

  it('rekeys persisted fallback duplicates to a single counted session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mrjmpl3-subagent-status-'));
    tempDirs.push(dir);
    const statePath = join(dir, 'state.json');

    await saveState(statePath, {
      children: {
        'subtask:part_1': {
          id: 'subtask:part_1',
          title: 'Fallback work',
          parentID: 'ses_parent',
          messageID: 'msg_1',
          source: 'subtask',
          targetSessionID: 'ses_child',
          status: 'running',
          startedAt: '2026-06-04T11:50:00.000Z',
          updatedAt: '2026-06-04T11:50:00.000Z',
        },
        ses_child: {
          id: 'ses_child',
          title: 'Fallback work',
          parentID: 'ses_parent',
          messageID: 'msg_1',
          source: 'session',
          targetSessionID: 'ses_child',
          status: 'running',
          startedAt: '2026-06-04T11:50:00.000Z',
          updatedAt: '2026-06-04T11:55:00.000Z',
        },
      },
      countedChildIDs: {
        'subtask:part_1': true,
        ses_child: true,
      },
      totalExecuted: 2,
      updatedAt: '2026-06-04T11:55:00.000Z',
    });

    const loaded = await loadState(statePath);

    expect(loaded.totalExecuted).toBe(1);
    expect(loaded.countedChildIDs.ses_child).toBe(true);
    expect(loaded.countedChildIDs['subtask:part_1']).toBeUndefined();
  });

  it('counts a fallback row and its later real session once', () => {
    const state = createEmptyState();

    upsertRunningChild(state, {
      id: 'subtask:part_1',
      title: 'Fallback work',
      parentID: 'ses_parent',
      messageID: 'msg_1',
      source: 'subtask',
    });
    upsertRunningChild(state, {
      id: 'ses_child',
      title: 'Fallback work',
      parentID: 'ses_parent',
      messageID: 'msg_1',
      source: 'session',
      targetSessionID: 'ses_child',
      updatedAt: '2026-06-04T11:55:00.000Z',
    });

    expect(state.totalExecuted).toBe(1);
    expect(state.countedChildIDs.ses_child).toBe(true);
    expect(state.countedChildIDs['subtask:part_1']).toBeUndefined();
  });
});
