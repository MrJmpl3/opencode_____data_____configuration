import type { TuiPluginApi } from '@opencode-ai/plugin/tui';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEmptyState } from '../state/state.ts';
import type { SubagentState } from '../state/types.ts';

async function waitForCondition(predicate: () => boolean, attempts = 20): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
  }
}

describe('refresh runtime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-04T05:25:00.000Z'));
  });

  afterEach(() => {
    delete process.env.MRJMPL3_SUBAGENT_STATUS_SQLITE_PATH;
    vi.useRealTimers();
  });

  it('replays buffered synthetic events after the session is selected', async () => {
    vi.resetModules();

    let capturedOnEvent: ((event: unknown) => void) | undefined;

    vi.doMock('../sources/events.ts', async () => {
      const actual = await vi.importActual<typeof import('../sources/events.ts')>('../sources/events.ts');

      return {
        ...actual,
        installEventBridge: vi.fn((_api, _refresh, onEvent) => {
          capturedOnEvent = onEvent;
          return () => {
            capturedOnEvent = undefined;
          };
        }),
      };
    });

    vi.doMock('../storage/persistence.ts', async () => {
      const actual = await vi.importActual<typeof import('../storage/persistence.ts')>('../storage/persistence.ts');

      return {
        ...actual,
        resolveStatePath: vi.fn(() => '/tmp/mrjmpl3-subagent-status-state.json'),
        resolveTextPath: vi.fn(() => '/tmp/mrjmpl3-subagent-status-status.txt'),
        loadState: vi.fn(async () => createEmptyState()),
        shouldPreserveStateOnStartup: vi.fn(() => false),
        createPersistQueue: vi.fn(() => async () => undefined),
      };
    });

    const { createTuiRuntime } = await import('../runtime/runtime.tsx');

    let state: SubagentState = createEmptyState();
    let sessionID = '';
    const api = {
      client: {
        session: {
          children: vi.fn(async () => ({ data: [] })),
        },
      },
      event: {},
      lifecycle: {
        onDispose: vi.fn(),
      },
      state: {
        path: {
          directory: '/tmp/workspace',
        },
        session: {
          messages: vi.fn(() => []),
          status: vi.fn(() => undefined),
        },
      },
    } as unknown as TuiPluginApi;

    const runtime = createTuiRuntime(api, {
      getState: () => state,
      setState: (nextState) => {
        state = nextState;
      },
      getSessionId: () => sessionID,
      setSessionId: (nextSessionID) => {
        sessionID = nextSessionID;
      },
      setNowMs: vi.fn(),
    });

    capturedOnEvent?.({
      type: 'message.part.updated',
      sessionID: 'ses_parent',
      properties: {
        part: {
          type: 'subtask',
          id: 'part_1',
          sessionID: 'ses_parent',
          messageID: 'msg_1',
          description: 'Buffered synthetic child',
          state: {
            input: {
              prompt: 'Buffered synthetic child',
            },
          },
        },
      },
    });

    await runtime.bootstrap();

    expect(state.children['subtask:part_1']).toBeUndefined();

    runtime.refreshFromSlot({ session_id: 'ses_parent' });
    await waitForCondition(() => state.children['subtask:part_1'] !== undefined);

    expect(state.children['subtask:part_1']).toMatchObject({
      id: 'subtask:part_1',
      parentID: 'ses_parent',
      source: 'subtask',
      status: 'running',
      title: 'Buffered synthetic child',
    });

    runtime.dispose();
  });

  it('hydrates terminal child state from SQLite recovery during refresh', async () => {
    vi.resetModules();

    const tempDir = await mkdtemp(join(tmpdir(), 'mrjmpl3-subagent-status-'));
    const databasePath = join(tempDir, 'opencode.db');
    process.env.MRJMPL3_SUBAGENT_STATUS_SQLITE_PATH = databasePath;

    execFileSync(
      'python3',
      [
        '-c',
        [
          'import json, sqlite3, sys',
          'path = sys.argv[1]',
          'conn = sqlite3.connect(path)',
          'cur = conn.cursor()',
          "cur.execute('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER)')",
          "cur.execute('CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)')",
          "cur.execute('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ('ses_child', 'ses_parent', 'Recovered child', 'sdd-apply', 1780550100000, 1780550400000, 5, 3, 0, 0, 0))",
          'payload = json.dumps({"type": "step-finish", "reason": "stop", "tokens": {"input": 5, "output": 3, "total": 8}, "time": {"end": 1780550400000}})',
          "cur.execute('INSERT INTO part VALUES (?, ?, ?, ?, ?)', ('prt_1', 'ses_child', 1780550399000, 1780550400000, payload))",
          'conn.commit()',
        ].join('\n'),
        databasePath,
      ],
      { encoding: 'utf8' },
    );

    vi.doMock('../storage/persistence.ts', async () => {
      const actual = await vi.importActual<typeof import('../storage/persistence.ts')>('../storage/persistence.ts');

      return {
        ...actual,
        resolveStatePath: vi.fn(() => '/tmp/mrjmpl3-subagent-status-state.json'),
        resolveTextPath: vi.fn(() => '/tmp/mrjmpl3-subagent-status-status.txt'),
        loadState: vi.fn(async () => ({
          children: {
            ses_child: {
              id: 'ses_child',
              title: 'Recovered child',
              parentID: 'ses_parent',
              source: 'session',
              status: 'running',
              startedAt: '2026-06-04T11:55:00.000Z',
              updatedAt: '2026-06-04T11:59:00.000Z',
            },
          },
          countedChildIDs: { ses_child: true },
          totalExecuted: 1,
          updatedAt: '2026-06-04T11:59:00.000Z',
        })),
        shouldPreserveStateOnStartup: vi.fn(() => true),
        createPersistQueue: vi.fn(() => async () => undefined),
      };
    });

    const { createTuiRuntime } = await import('../runtime/runtime.tsx');

    let state: SubagentState = createEmptyState();
    let sessionID = '';
    const api = {
      client: {
        session: {
          children: vi.fn(async () => ({
            data: [
              {
                id: 'ses_child',
                parentID: 'ses_parent',
                title: 'Recovered child',
                source: 'session',
                status: 'running',
                startedAt: '2026-06-04T11:55:00.000Z',
                updatedAt: '2026-06-04T11:59:00.000Z',
              },
            ],
          })),
        },
      },
      event: {},
      lifecycle: {
        onDispose: vi.fn(),
      },
      state: {
        path: {
          directory: '/tmp/workspace',
        },
        session: {
          messages: vi.fn(() => []),
          status: vi.fn(() => undefined),
        },
      },
    } as unknown as TuiPluginApi;

    const runtime = createTuiRuntime(api, {
      getState: () => state,
      setState: (nextState) => {
        state = nextState;
      },
      getSessionId: () => sessionID,
      setSessionId: (nextSessionID) => {
        sessionID = nextSessionID;
      },
      setNowMs: vi.fn(),
    });

    await runtime.bootstrap();
    runtime.refreshFromSlot({ session_id: 'ses_parent' });
    await waitForCondition(() => state.children.ses_child?.status === 'done');

    expect(state.children.ses_child).toMatchObject({
      status: 'done',
      endedAt: '2026-06-04T05:20:00.000Z',
      tokens: { input: 5, output: 3, total: 8 },
    });

    runtime.dispose();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('keeps children running when idle is the only evidence during refresh', async () => {
    vi.resetModules();

    vi.doMock('../storage/persistence.ts', async () => {
      const actual = await vi.importActual<typeof import('../storage/persistence.ts')>('../storage/persistence.ts');

      return {
        ...actual,
        resolveStatePath: vi.fn(() => '/tmp/mrjmpl3-subagent-status-state.json'),
        resolveTextPath: vi.fn(() => '/tmp/mrjmpl3-subagent-status-status.txt'),
        loadState: vi.fn(async () => createEmptyState()),
        shouldPreserveStateOnStartup: vi.fn(() => false),
        createPersistQueue: vi.fn(() => async () => undefined),
      };
    });

    const { createTuiRuntime } = await import('../runtime/runtime.tsx');

    let state: SubagentState = createEmptyState();
    let sessionID = '';
    const api = {
      client: {
        session: {
          children: vi.fn(async () => ({
            data: [
              {
                id: 'ses_child',
                parentID: 'ses_parent',
                title: 'Recovered child',
                source: 'session',
                status: 'running',
                startedAt: '2026-06-04T11:55:00.000Z',
                updatedAt: '2026-06-04T11:59:00.000Z',
              },
            ],
          })),
          status: vi.fn(async () => ({ data: { ses_child: { type: 'idle' } } })),
          messages: vi.fn(async () => ({ data: [] })),
        },
      },
      event: {},
      lifecycle: {
        onDispose: vi.fn(),
      },
      state: {
        path: {
          directory: '/tmp/workspace',
        },
        session: {
          messages: vi.fn(() => []),
          status: vi.fn(() => ({ type: 'idle' })),
        },
      },
    } as unknown as TuiPluginApi;

    const runtime = createTuiRuntime(api, {
      getState: () => state,
      setState: (nextState) => {
        state = nextState;
      },
      getSessionId: () => sessionID,
      setSessionId: (nextSessionID) => {
        sessionID = nextSessionID;
      },
      setNowMs: vi.fn(),
    });

    await runtime.bootstrap();
    runtime.refreshFromSlot({ session_id: 'ses_parent' });
    await waitForCondition(() => state.children.ses_child !== undefined);

    expect(state.children.ses_child).toMatchObject({
      status: 'running',
      endedAt: undefined,
    });

    runtime.dispose();
  });

  it('marks children done once explicit completion evidence arrives during refresh', async () => {
    vi.resetModules();

    vi.doMock('../storage/persistence.ts', async () => {
      const actual = await vi.importActual<typeof import('../storage/persistence.ts')>('../storage/persistence.ts');

      return {
        ...actual,
        resolveStatePath: vi.fn(() => '/tmp/mrjmpl3-subagent-status-state.json'),
        resolveTextPath: vi.fn(() => '/tmp/mrjmpl3-subagent-status-status.txt'),
        loadState: vi.fn(async () => createEmptyState()),
        shouldPreserveStateOnStartup: vi.fn(() => false),
        createPersistQueue: vi.fn(() => async () => undefined),
      };
    });

    const { createTuiRuntime } = await import('../runtime/runtime.tsx');

    let state: SubagentState = createEmptyState();
    let sessionID = '';
    const api = {
      client: {
        session: {
          children: vi.fn(async () => ({
            data: [
              {
                id: 'ses_child',
                parentID: 'ses_parent',
                title: 'Recovered child',
                source: 'session',
                status: 'running',
                startedAt: '2026-06-04T11:55:00.000Z',
                updatedAt: '2026-06-04T11:59:00.000Z',
              },
            ],
          })),
          status: vi.fn(async () => ({ data: { ses_child: { type: 'idle' } } })),
          messages: vi.fn(async () => ({
            data: [
              {
                info: {
                  time: {
                    completed: '2026-06-04T12:00:00.000Z',
                  },
                },
              },
            ],
          })),
        },
      },
      event: {},
      lifecycle: {
        onDispose: vi.fn(),
      },
      state: {
        path: {
          directory: '/tmp/workspace',
        },
        session: {
          messages: vi.fn(() => [
            {
              info: {
                time: {
                  completed: '2026-06-04T12:00:00.000Z',
                },
              },
            },
          ]),
          status: vi.fn(() => ({ type: 'idle' })),
        },
      },
    } as unknown as TuiPluginApi;

    const runtime = createTuiRuntime(api, {
      getState: () => state,
      setState: (nextState) => {
        state = nextState;
      },
      getSessionId: () => sessionID,
      setSessionId: (nextSessionID) => {
        sessionID = nextSessionID;
      },
      setNowMs: vi.fn(),
    });

    await runtime.bootstrap();
    runtime.refreshFromSlot({ session_id: 'ses_parent' });
    await waitForCondition(() => state.children.ses_child?.status === 'done');

    expect(state.children.ses_child).toMatchObject({
      status: 'done',
      endedAt: '2026-06-04T12:00:00.000Z',
    });

    runtime.dispose();
  });
});
