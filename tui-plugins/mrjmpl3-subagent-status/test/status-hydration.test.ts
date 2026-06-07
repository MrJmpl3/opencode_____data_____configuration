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

  it('prefers strict done evidence when error and done arrive with the same terminal timestamp', () => {
    expect(
      summarizeMessages([
        {
          type: 'step-finish',
          reason: 'stop',
          time: { end: '2026-06-04T12:01:30.000Z' },
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
