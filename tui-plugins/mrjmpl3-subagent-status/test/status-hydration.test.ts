import type { TuiPluginApi } from '@opencode-ai/plugin/tui';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
