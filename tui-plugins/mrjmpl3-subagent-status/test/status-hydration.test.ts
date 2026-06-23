import type { TuiPluginApi } from '@opencode-ai/plugin/tui';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setDebugEnabled } from '../src/shared/debug.ts';
import { createEmptyState } from '../src/domain/state.ts';
import {
  hydrateChildTokensFromLogs,
  hydrateChildStatusesFromClient,
  hydrateChildStatusesFromTuiState,
  summarizeMessages,
} from '../src/runtime/status-hydration.ts';

const createApi = (input: {
  tuiStatus?: unknown;
  tuiMessages?: unknown[];
  clientStatus?: Record<string, unknown>;
  clientMessages?: unknown[];
}): TuiPluginApi => {
  return {
    client: {
      session: {
        status: vi.fn(async () => ({ data: input.clientStatus ?? {} })),
        messages: vi.fn(async () => ({ data: input.clientMessages ?? [] })),
      },
    },
    state: {
      path: {
        directory: '/tmp/workspace',
      },
      session: {
        status: vi.fn(() => input.tuiStatus),
        messages: vi.fn(() => input.tuiMessages ?? []),
      },
    },
  } as unknown as TuiPluginApi;
};

describe('status hydration', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    setDebugEnabled(false);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();

    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('reopens a done row from newer TUI running evidence', () => {
    const state = createEmptyState();
    state.children.ses_child = {
      id: 'ses_child',
      title: 'Recovered child',
      parentID: 'ses_parent',
      source: 'session',
      targetSessionID: 'ses_child',
      status: 'done',
      color: 'green',
      startedAt: '2026-06-04T11:55:00.000Z',
      updatedAt: '2026-06-04T12:00:00.000Z',
      endedAt: '2026-06-04T12:00:00.000Z',
    };

    const changed = hydrateChildStatusesFromTuiState(
      createApi({
        tuiStatus: { type: 'running' },
        tuiMessages: [{ time: { updated: '2026-06-04T12:01:00.000Z' } }],
      }),
      state,
      ['ses_child'],
    );

    expect(changed).toBe(true);
    expect(state.children.ses_child).toMatchObject({
      status: 'running',
      color: 'yellow',
      updatedAt: '2026-06-04T12:01:00.000Z',
      endedAt: undefined,
    });
  });

  it('does not reopen a terminal row from stale TUI running evidence', () => {
    const state = createEmptyState();
    state.children.ses_child = {
      id: 'ses_child',
      title: 'Recovered child',
      parentID: 'ses_parent',
      source: 'session',
      targetSessionID: 'ses_child',
      status: 'error',
      color: 'red',
      startedAt: '2026-06-04T11:55:00.000Z',
      updatedAt: '2026-06-04T12:00:00.000Z',
      endedAt: '2026-06-04T12:00:00.000Z',
    };

    const changed = hydrateChildStatusesFromTuiState(
      createApi({
        tuiStatus: { type: 'running' },
        tuiMessages: [{ time: { updated: '2026-06-04T11:59:00.000Z' } }],
      }),
      state,
      ['ses_child'],
    );

    expect(changed).toBe(false);
    expect(state.children.ses_child).toMatchObject({
      status: 'error',
      color: 'red',
      updatedAt: '2026-06-04T12:00:00.000Z',
      endedAt: '2026-06-04T12:00:00.000Z',
    });
  });

  it('does not reopen a terminal recovery row from newer TUI running evidence', () => {
    const state = createEmptyState();
    state.children.ses_child = {
      id: 'ses_child',
      title: 'Recovered child',
      parentID: 'ses_parent',
      source: 'session',
      targetSessionID: 'ses_child',
      status: 'done',
      color: 'green',
      startedAt: '2026-06-04T11:55:00.000Z',
      updatedAt: '2026-06-04T12:00:00.000Z',
      endedAt: '2026-06-04T12:00:00.000Z',
    };
    const runningEvidenceSessionIDs = new Set<string>();

    const changed = hydrateChildStatusesFromTuiState(
      createApi({
        tuiStatus: { type: 'running' },
        tuiMessages: [{ time: { updated: '2026-06-04T12:01:00.000Z' } }],
      }),
      state,
      ['ses_child'],
      runningEvidenceSessionIDs,
      { terminalRecoverySessionIDs: new Set(['ses_child']) },
    );

    expect(changed).toBe(false);
    expect(runningEvidenceSessionIDs.has('ses_child')).toBe(false);
    expect(state.children.ses_child).toMatchObject({
      status: 'done',
      color: 'green',
      updatedAt: '2026-06-04T12:00:00.000Z',
      endedAt: '2026-06-04T12:00:00.000Z',
    });
  });

  it('reopens an errored row from newer client queued evidence', async () => {
    const state = createEmptyState();
    state.children.ses_child = {
      id: 'ses_child',
      title: 'Recovered child',
      parentID: 'ses_parent',
      source: 'session',
      targetSessionID: 'ses_child',
      status: 'error',
      color: 'red',
      startedAt: '2026-06-04T11:55:00.000Z',
      updatedAt: '2026-06-04T12:00:00.000Z',
      endedAt: '2026-06-04T12:00:00.000Z',
    };

    const changed = await hydrateChildStatusesFromClient(
      createApi({
        tuiMessages: [{ time: { updated: '2026-06-04T12:02:00.000Z' } }],
        clientStatus: {
          ses_child: {
            type: 'queued',
          },
        },
      }),
      state,
      ['ses_child'],
    );

    expect(changed).toBe(true);
    expect(state.children.ses_child).toMatchObject({
      status: 'running',
      color: 'yellow',
      updatedAt: '2026-06-04T12:02:00.000Z',
      endedAt: undefined,
    });
  });

  it('does not reopen a terminal recovery row from newer client running evidence', async () => {
    const state = createEmptyState();
    state.children.ses_child = {
      id: 'ses_child',
      title: 'Recovered child',
      parentID: 'ses_parent',
      source: 'session',
      targetSessionID: 'ses_child',
      status: 'done',
      color: 'green',
      startedAt: '2026-06-04T11:55:00.000Z',
      updatedAt: '2026-06-04T12:00:00.000Z',
      endedAt: '2026-06-04T12:00:00.000Z',
    };
    const runningEvidenceSessionIDs = new Set<string>();

    const changed = await hydrateChildStatusesFromClient(
      createApi({
        tuiMessages: [{ time: { updated: '2026-06-04T12:01:00.000Z' } }],
        clientStatus: {
          ses_child: {
            type: 'running',
          },
        },
        clientMessages: [{ time: { updated: '2026-06-04T12:01:00.000Z' } }],
      }),
      state,
      ['ses_child'],
      runningEvidenceSessionIDs,
      { terminalRecoverySessionIDs: new Set(['ses_child']) },
    );

    expect(changed).toBe(false);
    expect(runningEvidenceSessionIDs.has('ses_child')).toBe(false);
    expect(state.children.ses_child).toMatchObject({
      status: 'done',
      color: 'green',
      updatedAt: '2026-06-04T12:00:00.000Z',
      endedAt: '2026-06-04T12:00:00.000Z',
    });
  });

  it('preserves failed recency when client hydration repeats the same terminal status', async () => {
    const state = createEmptyState();
    state.children.ses_child = {
      id: 'ses_child',
      title: 'Recovered child',
      parentID: 'ses_parent',
      source: 'session',
      targetSessionID: 'ses_child',
      status: 'error',
      color: 'red',
      startedAt: '2026-06-04T11:55:00.000Z',
      updatedAt: '2026-06-04T12:00:00.000Z',
      endedAt: '2026-06-04T12:00:00.000Z',
    };

    const changed = await hydrateChildStatusesFromClient(
      createApi({
        clientStatus: {
          ses_child: {
            type: 'error',
            time: { ended: '2026-06-04T12:05:00.000Z' },
          },
        },
        clientMessages: [{ time: { updated: '2026-06-04T12:05:00.000Z' } }],
      }),
      state,
      ['ses_child'],
    );

    expect(changed).toBe(false);
    expect(state.children.ses_child).toMatchObject({
      status: 'error',
      updatedAt: '2026-06-04T12:00:00.000Z',
      endedAt: '2026-06-04T12:00:00.000Z',
    });
  });

  it('reads client message history once for multiple rows targeting the same running session', async () => {
    const state = createEmptyState();
    state.children.ses_child = {
      id: 'ses_child',
      title: 'Recovered child',
      parentID: 'ses_parent',
      source: 'session',
      targetSessionID: 'ses_child',
      status: 'running',
      color: 'yellow',
      startedAt: '2026-06-04T11:55:00.000Z',
      updatedAt: '2026-06-04T12:00:00.000Z',
    };
    state.children.row_child_alias = {
      id: 'row_child_alias',
      title: 'Recovered child alias',
      parentID: 'ses_parent',
      source: 'session',
      targetSessionID: 'ses_child',
      status: 'running',
      color: 'yellow',
      startedAt: '2026-06-04T11:55:00.000Z',
      updatedAt: '2026-06-04T12:00:00.000Z',
    };

    const clientMessagesSpy = vi.fn(async () => ({
      data: [{ time: { updated: '2026-06-04T12:01:00.000Z' } }],
    }));
    const tuiMessagesSpy = vi.fn(() => [{ time: { updated: '2026-06-04T12:02:00.000Z' } }]);

    const changed = await hydrateChildStatusesFromClient(
      {
        client: {
          session: {
            status: vi.fn(async () => ({ data: { ses_child: { type: 'running' } } })),
            messages: clientMessagesSpy,
          },
        },
        state: {
          path: {
            directory: '/tmp/workspace',
          },
          session: {
            status: vi.fn(() => ({ type: 'running' })),
            messages: tuiMessagesSpy,
          },
        },
      } as unknown as TuiPluginApi,
      state,
      ['ses_child'],
    );

    expect(changed).toBe(true);
    expect(clientMessagesSpy).toHaveBeenCalledTimes(1);
    expect(tuiMessagesSpy).not.toHaveBeenCalled();
    expect(state.children.ses_child).toMatchObject({
      status: 'running',
      updatedAt: '2026-06-04T12:01:00.000Z',
      endedAt: undefined,
    });
    expect(state.children.row_child_alias).toMatchObject({
      status: 'running',
      updatedAt: '2026-06-04T12:01:00.000Z',
      endedAt: undefined,
    });
  });

  it('does not close a running row from idle plus ambiguous generic completion evidence', async () => {
    const state = createEmptyState();
    state.children.ses_child = {
      id: 'ses_child',
      title: 'Recovered child',
      parentID: 'ses_parent',
      source: 'session',
      targetSessionID: 'ses_child',
      status: 'running',
      color: 'yellow',
      startedAt: '2026-06-04T11:55:00.000Z',
      updatedAt: '2026-06-04T12:00:00.000Z',
    };

    const changed = await hydrateChildStatusesFromClient(
      createApi({
        tuiMessages: [{ info: { time: { updated: '2026-06-04T12:01:00.000Z' } } }],
        clientStatus: {
          ses_child: {
            type: 'idle',
          },
        },
        clientMessages: [{ info: { time: { completed: '2026-06-04T12:01:30.000Z' } } }],
      }),
      state,
      ['ses_child'],
    );

    expect(changed).toBe(false);
    expect(state.children.ses_child).toMatchObject({
      status: 'running',
      color: 'yellow',
      updatedAt: '2026-06-04T12:00:00.000Z',
    });
    expect(state.children.ses_child).not.toHaveProperty('endedAt');
  });

  it('marks a running row done from explicit completed message evidence', async () => {
    const state = createEmptyState();
    state.children.ses_child = {
      id: 'ses_child',
      title: 'Recovered child',
      parentID: 'ses_parent',
      source: 'session',
      targetSessionID: 'ses_child',
      status: 'running',
      color: 'yellow',
      startedAt: '2026-06-04T11:55:00.000Z',
      updatedAt: '2026-06-04T12:00:00.000Z',
    };

    const changed = await hydrateChildStatusesFromClient(
      createApi({
        clientStatus: {
          ses_child: {
            type: 'idle',
          },
        },
        clientMessages: [
          {
            type: 'completed',
            time: { completed: '2026-06-04T12:01:30.000Z' },
          },
        ],
      }),
      state,
      ['ses_child'],
    );

    expect(changed).toBe(true);
    expect(state.children.ses_child).toMatchObject({
      status: 'done',
      color: 'green',
      endedAt: '2026-06-04T12:01:30.000Z',
      updatedAt: '2026-06-04T12:01:30.000Z',
    });
  });

  it('marks a running row done from step-finish stop when no newer live evidence exists', async () => {
    const state = createEmptyState();
    state.children.ses_child = {
      id: 'ses_child',
      title: 'Recovered child',
      parentID: 'ses_parent',
      source: 'session',
      targetSessionID: 'ses_child',
      status: 'running',
      color: 'yellow',
      startedAt: '2026-06-04T11:55:00.000Z',
      updatedAt: '2026-06-04T12:00:00.000Z',
    };

    const changed = await hydrateChildStatusesFromClient(
      createApi({
        clientStatus: {
          ses_child: {
            type: 'idle',
          },
        },
        clientMessages: [
          {
            type: 'step-finish',
            reason: 'stop',
            time: { end: '2026-06-04T12:01:30.000Z' },
          },
        ],
      }),
      state,
      ['ses_child'],
    );

    expect(changed).toBe(true);
    expect(state.children.ses_child).toMatchObject({
      status: 'done',
      color: 'green',
      endedAt: '2026-06-04T12:01:30.000Z',
      updatedAt: '2026-06-04T12:01:30.000Z',
    });
  });

  it('keeps live newer running evidence ahead of step-finish stop evidence', async () => {
    const state = createEmptyState();
    state.children.ses_child = {
      id: 'ses_child',
      title: 'Recovered child',
      parentID: 'ses_parent',
      source: 'session',
      targetSessionID: 'ses_child',
      status: 'running',
      color: 'yellow',
      startedAt: '2026-06-04T11:55:00.000Z',
      updatedAt: '2026-06-04T12:00:00.000Z',
    };

    const runningEvidenceSessionIDs = new Set<string>();
    hydrateChildStatusesFromTuiState(
      createApi({
        tuiStatus: { type: 'running' },
        tuiMessages: [{ time: { updated: '2026-06-04T12:02:00.000Z' } }],
      }),
      state,
      ['ses_child'],
      runningEvidenceSessionIDs,
    );

    const changed = await hydrateChildStatusesFromClient(
      createApi({
        clientStatus: {
          ses_child: {
            type: 'idle',
          },
        },
        clientMessages: [
          {
            type: 'step-finish',
            reason: 'stop',
            time: { end: '2026-06-04T12:01:30.000Z' },
          },
        ],
      }),
      state,
      ['ses_child'],
      runningEvidenceSessionIDs,
    );

    expect(changed).toBe(false);
    expect(state.children.ses_child).toMatchObject({
      status: 'running',
      color: 'yellow',
      updatedAt: '2026-06-04T12:02:00.000Z',
    });
    expect(state.children.ses_child?.endedAt).toBeUndefined();
  });

  it('summarizes step-finish stop as ambiguous successful completion evidence', () => {
    expect(
      summarizeMessages([
        {
          type: 'step-finish',
          reason: 'stop',
          time: { end: '2026-06-04T12:01:30.000Z' },
        },
      ]),
    ).toEqual({
      status: 'done',
      endedAt: '2026-06-04T12:01:30.000Z',
      evidence: 'ambiguous',
    });
  });

  it('keeps step-finish stop ambiguous when a newer step starts later', () => {
    expect(
      summarizeMessages([
        {
          type: 'step-finish',
          reason: 'stop',
          time: { end: '2026-06-04T12:01:30.000Z' },
        },
        {
          type: 'step-start',
          time: { start: '2026-06-04T12:02:00.000Z' },
        },
      ]),
    ).toEqual({});
  });

  it('summarizes failed step-finish evidence as error', () => {
    expect(
      summarizeMessages([
        {
          type: 'step-finish',
          reason: 'failed',
          time: { end: '2026-06-04T12:01:30.000Z' },
        },
      ]),
    ).toEqual({
      status: 'error',
      endedAt: '2026-06-04T12:01:30.000Z',
      evidence: 'ambiguous',
    });
  });

  it('prefers explicit done evidence when error and done arrive with the same terminal timestamp', () => {
    expect(
      summarizeMessages([
        {
          type: 'session.status',
          state: { status: 'completed' },
          time: { completed: '2026-06-04T12:01:30.000Z' },
        },
        {
          type: 'session.error',
          error: { message: 'boom' },
          time: { ended: '2026-06-04T12:01:30.000Z' },
        },
      ]),
    ).toEqual({
      status: 'done',
      endedAt: '2026-06-04T12:01:30.000Z',
    });
  });

  it('prefers later error evidence over earlier strict done evidence', () => {
    expect(
      summarizeMessages([
        {
          type: 'session.status',
          state: { status: 'completed' },
          time: { completed: '2026-06-04T12:01:00.000Z' },
        },
        {
          type: 'session.error',
          error: { message: 'boom' },
          time: { ended: '2026-06-04T12:01:30.000Z' },
        },
      ]),
    ).toEqual({
      status: 'error',
      endedAt: '2026-06-04T12:01:30.000Z',
    });
  });

  it('re-reads logs for done rows with partial token hydration so context can be backfilled', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mrjmpl3-subagent-status-data-'));
    tempDirs.push(dataDir);
    const logDir = join(dataDir, 'opencode', 'log');
    const logPath = join(logDir, '2026-06-04.log');

    vi.stubEnv('XDG_DATA_HOME', dataDir);
    await mkdir(logDir, { recursive: true });
    await writeFile(
      logPath,
      '2026-06-04T00:00:00.000Z session=ses_child {"tokens":{"total":20,"contextPercent":42.5}}',
      'utf8',
    );

    const state = createEmptyState();
    state.children.ses_child = {
      id: 'ses_child',
      title: 'Recovered child',
      parentID: 'ses_parent',
      source: 'session',
      targetSessionID: 'ses_child',
      status: 'done',
      color: 'green',
      startedAt: '2026-06-04T11:55:00.000Z',
      updatedAt: '2026-06-04T12:00:00.000Z',
      endedAt: '2026-06-04T12:00:00.000Z',
      tokens: { total: 20 },
    };

    expect(await hydrateChildTokensFromLogs(state)).toBe(true);
    expect(state.children.ses_child?.tokens).toEqual({ total: 20, contextPercent: 42.5 });
  });
});

describe('debug gating for status-hydration console.log replacements', () => {
  afterEach(() => {
    setDebugEnabled(false);
    vi.restoreAllMocks();
  });

  it('does not call console.log for protected-from-running log when debug is disabled', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const state = createEmptyState();
    state.children.ses_child = {
      id: 'ses_child',
      title: 'Child',
      parentID: 'ses_parent',
      source: 'session',
      targetSessionID: 'ses_child',
      status: 'running',
      startedAt: '2026-06-04T11:55:00.000Z',
      updatedAt: '2026-06-04T12:00:00.000Z',
    };

    setDebugEnabled(false);
    await hydrateChildStatusesFromClient(
      createApi({
        clientStatus: { ses_child: { type: 'running' } },
        clientMessages: [],
      }),
      state,
      ['ses_child'],
      undefined,
      { terminalRecoverySessionIDs: new Set(['ses_child']) },
    );

    expect(console.log).not.toHaveBeenCalled();
  });

  it('calls console.log for protected-from-running log when debug is enabled', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const state = createEmptyState();
    state.children.ses_child = {
      id: 'ses_child',
      title: 'Child',
      parentID: 'ses_parent',
      source: 'session',
      targetSessionID: 'ses_child',
      status: 'running',
      startedAt: '2026-06-04T11:55:00.000Z',
      updatedAt: '2026-06-04T12:00:00.000Z',
    };

    setDebugEnabled(true);
    await hydrateChildStatusesFromClient(
      createApi({
        clientStatus: { ses_child: { type: 'running' } },
        clientMessages: [],
      }),
      state,
      ['ses_child'],
      undefined,
      { terminalRecoverySessionIDs: new Set(['ses_child']) },
    );

    expect(console.log).toHaveBeenCalled();
  });
});

describe('characterization: shared hydration logic (pre-refactor baseline)', () => {
  afterEach(() => {
    setDebugEnabled(false);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const baseChild: import('../src/domain/types.ts').SubagentChild = {
    id: 'ses_child',
    title: 'Child',
    parentID: 'ses_parent',
    source: 'session',
    targetSessionID: 'ses_child',
    status: 'running',
    color: 'yellow',
    startedAt: '2026-06-04T11:55:00.000Z',
    updatedAt: '2026-06-04T12:00:00.000Z',
  };

  /**
   * Scenario 1: Running session — both sources report running with recent activity.
   * Both functions should keep the child running, update updatedAt, and collect evidence.
   */
  it('1a: hydrateChildStatusesFromTuiState — running session with activity marks running', () => {
    const state = createEmptyState();
    state.children.ses_child = { ...baseChild };
    const runningEv = new Set<string>();

    const changed = hydrateChildStatusesFromTuiState(
      createApi({
        tuiStatus: { type: 'running' },
        tuiMessages: [{ time: { updated: '2026-06-04T12:01:00.000Z' } }],
      }),
      state,
      ['ses_child'],
      runningEv,
    );

    expect(changed).toBe(true);
    expect(state.children.ses_child).toMatchObject({
      status: 'running',
      color: 'yellow',
      updatedAt: '2026-06-04T12:01:00.000Z',
    });
    expect(state.children.ses_child?.endedAt).toBeUndefined();
    expect(runningEv.has('ses_child')).toBe(true);
  });

  it('1b: hydrateChildStatusesFromClient — running session with activity marks running', async () => {
    const state = createEmptyState();
    state.children.ses_child = { ...baseChild };
    const runningEv = new Set<string>();

    const changed = await hydrateChildStatusesFromClient(
      createApi({
        tuiStatus: { type: 'running' },
        tuiMessages: [{ time: { updated: '2026-06-04T12:02:00.000Z' } }],
        clientStatus: { ses_child: { type: 'running' } },
        clientMessages: [{ time: { updated: '2026-06-04T12:01:00.000Z' } }],
      }),
      state,
      ['ses_child'],
      runningEv,
    );

    expect(changed).toBe(true);
    expect(state.children.ses_child).toMatchObject({
      status: 'running',
      color: 'yellow',
      // Client version: uses clientActivity.latestLiveActivityAt (from client messages)
      updatedAt: '2026-06-04T12:01:00.000Z',
    });
    expect(state.children.ses_child?.endedAt).toBeUndefined();
    expect(runningEv.has('ses_child')).toBe(true);
  });

  /**
   * Scenario 2: Terminal session — explicit completed message evidence.
   * Both functions should mark the child as done with the correct endedAt.
   */
  it('2a: hydrateChildStatusesFromTuiState — explicit completed marks done', () => {
    const state = createEmptyState();
    state.children.ses_child = { ...baseChild };
    const runningEv = new Set<string>();

    const changed = hydrateChildStatusesFromTuiState(
      createApi({
        // 'idle' is not in any status set → deriveSessionStatus returns undefined
        // terminalStatus also undefined → nextStatus comes from messageActivity.summary
        tuiStatus: { type: 'idle' },
        tuiMessages: [{ type: 'completed', time: { completed: '2026-06-04T12:01:30.000Z' } }],
      }),
      state,
      ['ses_child'],
      runningEv,
    );

    expect(changed).toBe(true);
    expect(state.children.ses_child).toMatchObject({
      status: 'done',
      color: 'green',
      endedAt: '2026-06-04T12:01:30.000Z',
      updatedAt: '2026-06-04T12:01:30.000Z',
    });
  });

  it('2b: hydrateChildStatusesFromClient — explicit completed marks done', async () => {
    const state = createEmptyState();
    state.children.ses_child = { ...baseChild };
    const runningEv = new Set<string>();

    const changed = await hydrateChildStatusesFromClient(
      createApi({
        tuiStatus: { type: 'idle' },
        tuiMessages: [],
        clientStatus: { ses_child: { type: 'idle' } },
        clientMessages: [{ type: 'completed', time: { completed: '2026-06-04T12:01:30.000Z' } }],
      }),
      state,
      ['ses_child'],
      runningEv,
    );

    expect(changed).toBe(true);
    expect(state.children.ses_child).toMatchObject({
      status: 'done',
      color: 'green',
      endedAt: '2026-06-04T12:01:30.000Z',
      updatedAt: '2026-06-04T12:01:30.000Z',
    });
  });

  /**
   * Scenario 3: Terminal via terminal session status (no message needed).
   * TUI: status === 'error' takes early error path. Client: falls through to nextStatus.
   * Both should produce the same result (mark error).
   */
  it('3a: hydrateChildStatusesFromTuiState — error session status marks error', () => {
    const state = createEmptyState();
    state.children.ses_child = { ...baseChild };
    const runningEv = new Set<string>();

    const changed = hydrateChildStatusesFromTuiState(
      createApi({
        // 'error' is directly in ERROR_SESSION_STATUS_VALUES
        tuiStatus: { type: 'error' },
        tuiMessages: [{ time: { updated: '2026-06-04T12:01:00.000Z' } }],
      }),
      state,
      ['ses_child'],
      runningEv,
    );

    expect(changed).toBe(true);
    // TUI early error path: endedAt = latestLiveActivityAt ?? child.endedAt ?? child.updatedAt
    // latestLiveActivityAt = '2026-06-04T12:01:00.000Z' (from 'updated')
    expect(state.children.ses_child).toMatchObject({
      status: 'error',
      color: 'red',
      endedAt: '2026-06-04T12:01:00.000Z',
      updatedAt: '2026-06-04T12:01:00.000Z',
    });
  });

  it('3b: hydrateChildStatusesFromClient — error session status marks error', async () => {
    const state = createEmptyState();
    state.children.ses_child = { ...baseChild };
    const runningEv = new Set<string>();

    const changed = await hydrateChildStatusesFromClient(
      createApi({
        tuiStatus: { type: 'error' },
        tuiMessages: [{ time: { updated: '2026-06-04T12:02:00.000Z' } }],
        clientStatus: { ses_child: { type: 'error' } },
        clientMessages: [],
      }),
      state,
      ['ses_child'],
      runningEv,
    );

    expect(changed).toBe(true);
    // Client version: error goes through nextStatus path.
    // endedAt = sessionStatusEndedAt(clientSessionStatus) ?? clientActivity.summary.endedAt ?? ...
    // clientSessionStatus is { type: 'error' }, no time field → sessionStatusEndedAt returns undefined
    // clientActivity from [] has empty summary → undefined
    // tuiActivity has updated at '2026-06-04T12:02:00.000Z' → used as fallback
    expect(state.children.ses_child).toMatchObject({
      status: 'error',
      color: 'red',
      endedAt: '2026-06-04T12:02:00.000Z',
      updatedAt: '2026-06-04T12:02:00.000Z',
    });
  });

  /**
   * Scenario 4: Ambiguous step-finish — both functions should produce done with ambiguous evidence
   * when there's no newer live activity and no running evidence.
   */
  it('4a: hydrateChildStatusesFromTuiState — step-finish stop done with ambiguous evidence', () => {
    const state = createEmptyState();
    state.children.ses_child = { ...baseChild };

    const changed = hydrateChildStatusesFromTuiState(
      createApi({
        tuiStatus: { type: 'idle' },
        tuiMessages: [
          {
            type: 'step-finish',
            reason: 'stop',
            time: { end: '2026-06-04T12:01:30.000Z' },
          },
        ],
      }),
      state,
      ['ses_child'],
    );

    expect(changed).toBe(true);
    // nextStatus = undefined ?? 'done' (from analyzeMessages)
    // endedAt: sessionStatusEndedAt({ type: 'idle' }) = undefined
    //   → messageActivity.summary.endedAt = '2026-06-04T12:01:30.000Z'
    expect(state.children.ses_child).toMatchObject({
      status: 'done',
      color: 'green',
      endedAt: '2026-06-04T12:01:30.000Z',
      updatedAt: '2026-06-04T12:01:30.000Z',
    });
  });

  it('4b: hydrateChildStatusesFromClient — step-finish stop done with ambiguous evidence', async () => {
    const state = createEmptyState();
    state.children.ses_child = { ...baseChild };

    const changed = await hydrateChildStatusesFromClient(
      createApi({
        tuiStatus: { type: 'idle' },
        tuiMessages: [],
        clientStatus: { ses_child: { type: 'idle' } },
        clientMessages: [
          {
            type: 'step-finish',
            reason: 'stop',
            time: { end: '2026-06-04T12:01:30.000Z' },
          },
        ],
      }),
      state,
      ['ses_child'],
    );

    expect(changed).toBe(true);
    expect(state.children.ses_child).toMatchObject({
      status: 'done',
      color: 'green',
      endedAt: '2026-06-04T12:01:30.000Z',
      updatedAt: '2026-06-04T12:01:30.000Z',
    });
  });

  /**
   * Scenario 5: Running evidence from activity without terminal session status.
   * When status is not terminal and messages have no summary, but live activity exists,
   * both functions should add running evidence.
   */
  it('5a: hydrateChildStatusesFromTuiState — non-terminal status with live activity adds running evidence', () => {
    const state = createEmptyState();
    state.children.ses_child = {
      ...baseChild,
      // Child was marked done but has newer activity — should reopen
      status: 'done',
      color: 'green',
      endedAt: '2026-06-04T12:00:00.000Z',
    };
    const runningEv = new Set<string>();

    const changed = hydrateChildStatusesFromTuiState(
      createApi({
        // status derived from tuiStatus: { status: 'busy' } → 'busy' is RUNNING → 'running' path
        // Actually let's test the non-terminal no-nextStatus path instead
        tuiStatus: { type: 'unknown-status' },
        tuiMessages: [{ time: { updated: '2026-06-04T12:03:00.000Z' } }],
      }),
      state,
      ['ses_child'],
      runningEv,
    );

    expect(changed).toBe(true);
    expect(state.children.ses_child).toMatchObject({
      status: 'running',
      color: 'yellow',
      updatedAt: '2026-06-04T12:03:00.000Z',
    });
    expect(state.children.ses_child?.endedAt).toBeUndefined();
    expect(runningEv.has('ses_child')).toBe(true);
  });

  it('5b: hydrateChildStatusesFromClient — non-terminal status with live activity adds running evidence', async () => {
    const state = createEmptyState();
    state.children.ses_child = {
      ...baseChild,
      status: 'done',
      color: 'green',
      endedAt: '2026-06-04T12:00:00.000Z',
    };
    const runningEv = new Set<string>();

    const changed = await hydrateChildStatusesFromClient(
      createApi({
        tuiStatus: { type: 'unknown-status' },
        tuiMessages: [{ time: { updated: '2026-06-04T12:03:00.000Z' } }],
        clientStatus: { ses_child: { type: 'unknown-status' } },
        clientMessages: [{ time: { updated: '2026-06-04T12:03:00.000Z' } }],
      }),
      state,
      ['ses_child'],
      runningEv,
    );

    expect(changed).toBe(true);
    expect(state.children.ses_child).toMatchObject({
      status: 'running',
      color: 'yellow',
      updatedAt: '2026-06-04T12:03:00.000Z',
    });
    expect(state.children.ses_child?.endedAt).toBeUndefined();
    expect(runningEv.has('ses_child')).toBe(true);
  });

  /**
   * Scenario 6: Ambiguous guard — when runningEvidenceIDs already has the session,
   * ambiguous evidence should NOT override it.
   */
  it('6a: hydrateChildStatusesFromTuiState — preserves running evidence over ambiguous step-finish', () => {
    const state = createEmptyState();
    state.children.ses_child = { ...baseChild };
    // Pre-populate running evidence
    const runningEv = new Set<string>(['ses_child']);

    const changed = hydrateChildStatusesFromTuiState(
      createApi({
        tuiStatus: { type: 'idle' },
        tuiMessages: [
          {
            type: 'step-finish',
            reason: 'stop',
            time: { end: '2026-06-04T12:01:30.000Z' },
          },
        ],
      }),
      state,
      ['ses_child'],
      runningEv,
    );

    // Ambiguous + running evidence → skip
    expect(changed).toBe(false);
    expect(state.children.ses_child).toMatchObject({
      status: 'running',
      color: 'yellow',
    });
    expect(runningEv.has('ses_child')).toBe(true);
  });

  it('6b: hydrateChildStatusesFromClient — preserves running evidence over ambiguous step-finish', async () => {
    const state = createEmptyState();
    state.children.ses_child = { ...baseChild };
    const runningEv = new Set<string>(['ses_child']);

    const changed = await hydrateChildStatusesFromClient(
      createApi({
        tuiStatus: { type: 'idle' },
        tuiMessages: [
          {
            type: 'step-finish',
            reason: 'stop',
            time: { end: '2026-06-04T12:01:30.000Z' },
          },
        ],
        clientStatus: { ses_child: { type: 'idle' } },
        clientMessages: [
          {
            type: 'step-finish',
            reason: 'stop',
            time: { end: '2026-06-04T12:01:30.000Z' },
          },
        ],
      }),
      state,
      ['ses_child'],
      runningEv,
    );

    expect(changed).toBe(false);
    expect(state.children.ses_child).toMatchObject({
      status: 'running',
      color: 'yellow',
    });
  });

  /**
   * Scenario 7: Recovery protection — terminalRecoverySessionIDs prevents running.
   */
  it('7a: hydrateChildStatusesFromTuiState — recovery protection prevents running', () => {
    const state = createEmptyState();
    state.children.ses_child = { ...baseChild };
    const runningEv = new Set<string>();

    const changed = hydrateChildStatusesFromTuiState(
      createApi({
        tuiStatus: { type: 'running' },
        tuiMessages: [{ time: { updated: '2026-06-04T12:01:00.000Z' } }],
      }),
      state,
      ['ses_child'],
      runningEv,
      { terminalRecoverySessionIDs: new Set(['ses_child']) },
    );

    expect(changed).toBe(false);
    expect(runningEv.has('ses_child')).toBe(false);
  });

  it('7b: hydrateChildStatusesFromClient — recovery protection prevents running', async () => {
    const state = createEmptyState();
    state.children.ses_child = { ...baseChild };
    const runningEv = new Set<string>();

    const changed = await hydrateChildStatusesFromClient(
      createApi({
        tuiStatus: { type: 'running' },
        tuiMessages: [],
        clientStatus: { ses_child: { type: 'running' } },
        clientMessages: [],
      }),
      state,
      ['ses_child'],
      runningEv,
      { terminalRecoverySessionIDs: new Set(['ses_child']) },
    );

    expect(changed).toBe(false);
    expect(runningEv.has('ses_child')).toBe(false);
  });
});
