import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createEmptyState,
  getCounts,
  markChildRunning,
  markChildStatus,
  pruneOrphanedSyntheticRunningChildren,
  pruneTerminalChildren,
  replaceChildren,
  upsertChildDetails,
  upsertRunningChild,
} from '../src/domain/state.ts';
import { loadState, resolveStatePath, saveState } from '../src/infrastructure/persistence.ts';

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

  it('derives a stable workspace-scoped state path', () => {
    const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;

    try {
      process.env.XDG_RUNTIME_DIR = '/run/user/1000';

      const first = resolveStatePath('/workspaces/project-a');
      const second = resolveStatePath('/workspaces/project-a');
      const different = resolveStatePath('/workspaces/project-b');

      expect(first).toBe(second);
      expect(first).not.toContain(`pid-${process.pid}`);
      expect(first).not.toBe(different);
    } finally {
      if (previousRuntimeDir === undefined) {
        delete process.env.XDG_RUNTIME_DIR;
      } else {
        process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
      }
    }
  });

  it('respects the explicit persisted state path option', () => {
    expect(resolveStatePath({ workspaceDirectory: '/workspaces/project-a', statePath: '/tmp/custom-state.json' })).toBe(
      '/tmp/custom-state.json',
    );
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

  it('prunes old terminal children and orphaned synthetic running rows when loading persisted state', async () => {
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
      'tool:part_1': {
        id: 'tool:part_1',
        title: 'Stale tool',
        parentID: 'ses_missing',
        source: 'tool',
        status: 'running',
        startedAt: '2026-06-04T11:52:00.000Z',
        updatedAt: '2026-06-04T11:52:00.000Z',
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
    expect(loaded.countedChildIDs).toEqual({
      ses_recent: true,
      ses_running: true,
    });
    expect(loaded.totalExecuted).toBe(3);
    expect(getCounts(loaded)).toEqual({ running: 1, done: 1, error: 0 });
  });

  it('prunes orphaned synthetic running rows that are no longer anchored to an active session', () => {
    const state = createEmptyState();
    state.children = {
      ses_parent: {
        id: 'ses_parent',
        title: 'Parent runner',
        parentID: 'ses_root',
        source: 'session',
        status: 'done',
        startedAt: '2026-06-04T11:40:00.000Z',
        updatedAt: '2026-06-04T11:45:00.000Z',
        endedAt: '2026-06-04T11:45:00.000Z',
      },
      'subtask:part_1': {
        id: 'subtask:part_1',
        title: 'Detached fallback',
        parentID: 'ses_parent',
        source: 'subtask',
        status: 'running',
        startedAt: '2026-06-04T11:50:00.000Z',
        updatedAt: '2026-06-04T11:50:00.000Z',
      },
    };

    expect(pruneOrphanedSyntheticRunningChildren(state)).toBe(true);
    expect(state.children['subtask:part_1']).toBeUndefined();
    expect(state.children.ses_parent).toBeDefined();
  });

  it('prunes synthetic tool wrappers even when no real session anchor remains', () => {
    const state = createEmptyState();
    state.children['tool:delegate_1'] = {
      id: 'tool:delegate_1',
      title: 'Detached wrapper',
      parentID: 'ses_parent',
      source: 'tool',
      targetSessionID: 'ses_child',
      status: 'running',
      startedAt: '2026-06-04T11:50:00.000Z',
      updatedAt: '2026-06-04T11:50:00.000Z',
    };
    state.children['subtask:part_1'] = {
      id: 'subtask:part_1',
      title: 'Fallback row',
      parentID: 'ses_parent',
      source: 'subtask',
      targetSessionID: 'ses_child',
      status: 'running',
      startedAt: '2026-06-04T11:50:00.000Z',
      updatedAt: '2026-06-04T11:50:00.000Z',
    };

    expect(pruneOrphanedSyntheticRunningChildren(state)).toBe(true);
    expect(state.children['tool:delegate_1']).toBeUndefined();
    expect(state.children['subtask:part_1']).toBeDefined();
  });

  it('drops stale counted ids when replacing children with a pruned snapshot', () => {
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
    };
    state.countedChildIDs = { ses_old: true };
    state.totalExecuted = 1;

    expect(
      replaceChildren(state, [
        {
          id: 'ses_recent',
          title: 'Recent runner',
          parentID: 'ses_parent',
          status: 'running',
          startedAt: '2026-06-04T11:40:00.000Z',
          updatedAt: '2026-06-04T11:45:00.000Z',
        },
      ]),
    ).toBe(true);

    expect(state.children.ses_old).toBeUndefined();
    expect(state.countedChildIDs).toEqual({ ses_recent: true });
    expect(state.totalExecuted).toBe(2);
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
      purgedSessionIDs: {},
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

  it('preserves a terminal child when later running evidence arrives', () => {
    const state = createEmptyState();

    upsertRunningChild(state, {
      id: 'ses_child',
      title: 'Recovered child',
      parentID: 'ses_parent',
      source: 'session',
      status: 'done',
      startedAt: '2026-06-04T11:55:00.000Z',
      updatedAt: '2026-06-04T11:56:00.000Z',
      endedAt: '2026-06-04T11:56:00.000Z',
    });

    const elapsedMs = state.children.ses_child?.elapsedMs;

    vi.advanceTimersByTime(60_000);

    expect(
      upsertRunningChild(state, {
        id: 'ses_child',
        title: 'Recovered child',
        parentID: 'ses_parent',
        source: 'session',
        status: 'running',
        startedAt: '2026-06-04T11:55:00.000Z',
        updatedAt: '2026-06-04T12:00:00.000Z',
      }),
    ).toBe(false);

    expect(state.children.ses_child).toMatchObject({
      status: 'done',
      updatedAt: '2026-06-04T11:56:00.000Z',
      endedAt: '2026-06-04T11:56:00.000Z',
      elapsedMs,
    });
  });

  it('reopens matching rows with running color and cleared terminal markers', () => {
    const state = createEmptyState();
    state.children.ses_child = {
      id: 'ses_child',
      title: 'Recovered child',
      parentID: 'ses_parent',
      source: 'session',
      status: 'running',
      color: 'green',
      startedAt: '2026-06-04T11:55:00.000Z',
      updatedAt: '2026-06-04T11:56:00.000Z',
      endedAt: '2026-06-04T11:56:00.000Z',
    };
    state.children['tool:ses_child'] = {
      id: 'tool:ses_child',
      title: 'Recovered child',
      parentID: 'ses_parent',
      source: 'tool',
      targetSessionID: 'ses_child',
      status: 'done',
      color: 'green',
      startedAt: '2026-06-04T11:55:00.000Z',
      updatedAt: '2026-06-04T11:56:00.000Z',
      endedAt: '2026-06-04T11:56:00.000Z',
    };

    expect(markChildRunning(state, 'ses_child', '2026-06-04T12:00:00.000Z')).toBe(true);
    expect(state.children.ses_child).toMatchObject({
      status: 'running',
      color: 'yellow',
      updatedAt: '2026-06-04T12:00:00.000Z',
      endedAt: undefined,
    });
    expect(state.children['tool:ses_child']).toMatchObject({
      status: 'running',
      color: 'yellow',
      updatedAt: '2026-06-04T12:00:00.000Z',
      endedAt: undefined,
    });
  });

  it('does not resurrect a terminal session after retention pruning', () => {
    const state = createEmptyState();

    upsertRunningChild(state, {
      id: 'ses_pruned',
      title: 'Pruned child',
      parentID: 'ses_parent',
      source: 'session',
      status: 'done',
      startedAt: '2026-06-04T10:00:00.000Z',
      updatedAt: '2026-06-04T10:05:00.000Z',
      endedAt: '2026-06-04T10:05:00.000Z',
    });

    expect(pruneTerminalChildren(state, Date.parse('2026-06-04T12:00:00.000Z'))).toBe(true);
    expect(state.children.ses_pruned).toBeUndefined();
    expect(state.purgedSessionIDs.ses_pruned).toBe(true);

    expect(
      upsertRunningChild(state, {
        id: 'ses_pruned',
        title: 'Pruned child',
        parentID: 'ses_parent',
        source: 'session',
        status: 'running',
        startedAt: '2026-06-04T11:59:00.000Z',
        updatedAt: '2026-06-04T12:00:00.000Z',
      }),
    ).toBe(false);

    expect(state.children.ses_pruned).toBeUndefined();
  });

  it('does not reopen a terminal row from stale running evidence', () => {
    const state = createEmptyState();

    state.children.ses_child = {
      id: 'ses_child',
      title: 'Recovered child',
      parentID: 'ses_parent',
      source: 'session',
      status: 'done',
      color: 'green',
      startedAt: '2026-06-04T11:55:00.000Z',
      updatedAt: '2026-06-04T12:00:00.000Z',
      endedAt: '2026-06-04T12:00:00.000Z',
    };

    expect(markChildRunning(state, 'ses_child', '2026-06-04T11:59:59.000Z')).toBe(false);
    expect(state.children.ses_child).toMatchObject({
      status: 'done',
      updatedAt: '2026-06-04T12:00:00.000Z',
      endedAt: '2026-06-04T12:00:00.000Z',
      color: 'green',
    });
  });

  it('does not let older terminal evidence override a newer running row', () => {
    const state = createEmptyState();

    state.children.ses_child = {
      id: 'ses_child',
      title: 'Recovered child',
      parentID: 'ses_parent',
      source: 'session',
      status: 'running',
      color: 'yellow',
      startedAt: '2026-06-04T11:55:00.000Z',
      updatedAt: '2026-06-04T12:01:00.000Z',
    };

    expect(markChildStatus(state, 'ses_child', 'error', '2026-06-04T12:00:00.000Z')).toBe(false);
    expect(state.children.ses_child).toMatchObject({
      status: 'running',
      updatedAt: '2026-06-04T12:01:00.000Z',
      color: 'yellow',
    });
    expect(state.children.ses_child).not.toHaveProperty('endedAt');
  });

  it('does not let older detail updates roll timestamps backwards', () => {
    const state = createEmptyState();

    state.children.ses_child = {
      id: 'ses_child',
      title: 'Recovered child',
      parentID: 'ses_parent',
      source: 'session',
      status: 'running',
      color: 'yellow',
      startedAt: '2026-06-04T11:55:00.000Z',
      updatedAt: '2026-06-04T12:01:00.000Z',
    };

    expect(
      upsertChildDetails(state, 'ses_child', {
        summary: 'Recovered from older source',
        updatedAt: '2026-06-04T12:00:00.000Z',
      }),
    ).toBe(true);

    expect(state.children.ses_child).toMatchObject({
      status: 'running',
      updatedAt: '2026-06-04T12:01:00.000Z',
      summary: 'Recovered from older source',
    });
  });
});
