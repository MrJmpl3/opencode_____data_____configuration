import type { TuiPluginApi } from '@opencode-ai/plugin/tui';
import { describe, expect, it, vi } from 'vitest';

import { createEmptyState } from '../src/domain/state.ts';
import {
  hydrateChildStatusesFromClient,
  hydrateChildStatusesFromTuiState,
} from '../src/runtime/status-hydration.ts';

function createApi(input: {
  tuiStatus?: unknown;
  tuiMessages?: unknown[];
  clientStatus?: Record<string, unknown>;
  clientMessages?: unknown[];
}): TuiPluginApi {
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
}

describe('status hydration', () => {
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
});
