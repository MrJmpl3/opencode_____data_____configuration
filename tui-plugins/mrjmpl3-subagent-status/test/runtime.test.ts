import type { TuiPluginApi } from '@opencode-ai/plugin/tui';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEmptyState } from '../src/domain/state.ts';
import type { SubagentState } from '../src/domain/types.ts';
import { resolveSubagentStatusPluginOptions } from '../src/runtime/options.ts';
import { deferred } from './fixtures/deferred.ts';

const waitForCondition = async (predicate: () => boolean, attempts = 5000): Promise<void> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1);
  }

  throw new Error('Condition not satisfied within allotted attempts.');
};

describe('refresh runtime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-04T05:25:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock('../src/runtime/events/bridge.ts');
    vi.doUnmock('../src/infrastructure/persistence.ts');
    vi.doUnmock('../src/infrastructure/recovery-sources.ts');
  });

  it('replays buffered synthetic events after the session is selected', async () => {
    vi.resetModules();

    let capturedOnEvent: ((event: unknown) => void) | undefined;

    vi.doMock('../src/runtime/events/bridge.ts', async () => {
      const actual = await vi.importActual<typeof import('../src/runtime/events/bridge.ts')>(
        '../src/runtime/events/bridge.ts',
      );

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

    vi.doMock('../src/infrastructure/persistence.ts', async () => {
      const actual = await vi.importActual<typeof import('../src/infrastructure/persistence.ts')>(
        '../src/infrastructure/persistence.ts',
      );

      return {
        ...actual,
        resolveStatePath: vi.fn(() => '/tmp/mrjmpl3-subagent-status-state.json'),
        resolveTextPath: vi.fn(() => '/tmp/mrjmpl3-subagent-status-status.txt'),
        loadState: vi.fn(async () => createEmptyState()),
        shouldPreserveStateOnStartup: vi.fn(() => false),
        createPersistQueue: vi.fn(() => async () => undefined),
      };
    });

    const { createTuiRuntime } = await import('../src/runtime/tui-runtime.ts');

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

  it('persists an empty snapshot immediately when switching session scope', async () => {
    vi.resetModules();

    const persistSpy = vi.fn(async () => undefined);
    const refreshGate = deferred<{ data: [] }>();

    vi.doMock('../src/infrastructure/persistence.ts', async () => {
      const actual = await vi.importActual<typeof import('../src/infrastructure/persistence.ts')>(
        '../src/infrastructure/persistence.ts',
      );

      return {
        ...actual,
        resolveStatePath: vi.fn(() => '/tmp/mrjmpl3-subagent-status-state.json'),
        resolveTextPath: vi.fn(() => '/tmp/mrjmpl3-subagent-status-status.txt'),
        loadState: vi.fn(async () => createEmptyState()),
        shouldPreserveStateOnStartup: vi.fn(() => false),
        createPersistQueue: vi.fn(() => persistSpy),
      };
    });

    const { createTuiRuntime } = await import('../src/runtime/tui-runtime.ts');

    let state: SubagentState = createEmptyState();
    state.children.ses_old = {
      id: 'ses_old',
      title: 'Old child',
      parentID: 'ses_parent',
      source: 'session',
      status: 'running',
      startedAt: '2026-06-04T11:55:00.000Z',
      updatedAt: '2026-06-04T11:59:00.000Z',
    };
    let sessionID = 'ses_old';
    const api = {
      client: {
        session: {
          children: vi.fn(() => refreshGate.promise),
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

    runtime.refreshFromSlot({ session_id: 'ses_new' });
    await waitForCondition(() => persistSpy.mock.calls.length > 0);

    expect(sessionID).toBe('ses_new');
    expect(Object.keys(state.children)).toEqual([]);
    expect(persistSpy).toHaveBeenCalledWith(
      expect.objectContaining({ children: {} }),
      expect.objectContaining({ source: 'refresh' }),
    );

    refreshGate.resolve({ data: [] });
    runtime.dispose();
  });

  it('persists an empty snapshot immediately when leaving session scope', async () => {
    vi.resetModules();

    const persistSpy = vi.fn(async () => undefined);

    vi.doMock('../src/infrastructure/persistence.ts', async () => {
      const actual = await vi.importActual<typeof import('../src/infrastructure/persistence.ts')>(
        '../src/infrastructure/persistence.ts',
      );

      return {
        ...actual,
        resolveStatePath: vi.fn(() => '/tmp/mrjmpl3-subagent-status-state.json'),
        resolveTextPath: vi.fn(() => '/tmp/mrjmpl3-subagent-status-status.txt'),
        loadState: vi.fn(async () => createEmptyState()),
        shouldPreserveStateOnStartup: vi.fn(() => false),
        createPersistQueue: vi.fn(() => persistSpy),
      };
    });

    const { createTuiRuntime } = await import('../src/runtime/tui-runtime.ts');

    let state: SubagentState = createEmptyState();
    state.children.ses_old = {
      id: 'ses_old',
      title: 'Old child',
      parentID: 'ses_parent',
      source: 'session',
      status: 'running',
      startedAt: '2026-06-04T11:55:00.000Z',
      updatedAt: '2026-06-04T11:59:00.000Z',
    };
    let sessionID = 'ses_old';
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

    runtime.refreshFromSlot({});
    await waitForCondition(() => persistSpy.mock.calls.length > 0);

    expect(sessionID).toBe('');
    expect(Object.keys(state.children)).toEqual([]);
    expect(persistSpy).toHaveBeenCalledWith(
      expect.objectContaining({ children: {} }),
      expect.objectContaining({ source: 'refresh' }),
    );

    runtime.dispose();
  });

  it('keeps the main refresh path responsive while recovery hydration finishes in the background', async () => {
    vi.resetModules();

    const recoveryGate = deferred<void>();

    vi.doMock('../src/infrastructure/persistence.ts', async () => {
      const actual = await vi.importActual<typeof import('../src/infrastructure/persistence.ts')>(
        '../src/infrastructure/persistence.ts',
      );

      return {
        ...actual,
        resolveStatePath: vi.fn(() => '/tmp/mrjmpl3-subagent-status-state.json'),
        resolveTextPath: vi.fn(() => '/tmp/mrjmpl3-subagent-status-status.txt'),
        loadState: vi.fn(async () => createEmptyState()),
        shouldPreserveStateOnStartup: vi.fn(() => false),
        createPersistQueue: vi.fn(() => async () => undefined),
      };
    });

    vi.doMock('../src/infrastructure/recovery-sources.ts', () => ({
      createRecoverySources: vi.fn(() => [
        {
          hydrateState: vi.fn(async (state: SubagentState) => {
            await recoveryGate.promise;

            const child = state.children.ses_child;
            if (child) {
              child.status = 'done';
              child.endedAt = '2026-06-04T05:21:00.000Z';
              child.updatedAt = '2026-06-04T05:21:00.000Z';
            }

            return { changed: true, authoritativeSessionIDs: ['ses_child'] };
          }),
        },
      ]),
    }));

    const { createTuiRuntime } = await import('../src/runtime/tui-runtime.ts');

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
                title: 'Recovered later',
                source: 'session',
                status: 'running',
                startedAt: '2026-06-04T05:15:00.000Z',
                updatedAt: '2026-06-04T05:20:00.000Z',
              },
            ],
          })),
          status: vi.fn(async () => ({ data: {} })),
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

    await waitForCondition(() => state.children.ses_child?.status === 'running');
    expect(state.children.ses_child).toMatchObject({
      status: 'running',
      updatedAt: '2026-06-04T05:20:00.000Z',
    });

    recoveryGate.resolve();
    await waitForCondition(() => state.children.ses_child?.status === 'done');

    expect(state.children.ses_child).toMatchObject({
      status: 'done',
      endedAt: '2026-06-04T05:21:00.000Z',
    });

    runtime.dispose();
  });

  it('hydrates terminal child state from SQLite recovery during refresh', async () => {
    vi.resetModules();

    const tempDir = await mkdtemp(join(tmpdir(), 'mrjmpl3-subagent-status-'));
    const databasePath = join(tempDir, 'opencode.db');

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

    vi.doMock('../src/infrastructure/persistence.ts', async () => {
      const actual = await vi.importActual<typeof import('../src/infrastructure/persistence.ts')>(
        '../src/infrastructure/persistence.ts',
      );

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
              startedAt: '2026-06-04T05:15:00.000Z',
              updatedAt: '2026-06-04T05:19:00.000Z',
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

    const { createTuiRuntime } = await import('../src/runtime/tui-runtime.ts');

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
                startedAt: '2026-06-04T05:15:00.000Z',
                updatedAt: '2026-06-04T05:19:00.000Z',
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

    const runtime = createTuiRuntime(
      api,
      {
        getState: () => state,
        setState: (nextState) => {
          state = nextState;
        },
        getSessionId: () => sessionID,
        setSessionId: (nextSessionID) => {
          sessionID = nextSessionID;
        },
        setNowMs: vi.fn(),
      },
      resolveSubagentStatusPluginOptions({ recovery: { sqliteDatabasePath: databasePath } }),
    );

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

  it('reopens a persisted terminal child during bootstrap once newer live running evidence arrives', async () => {
    vi.resetModules();

    vi.doMock('../src/infrastructure/persistence.ts', async () => {
      const actual = await vi.importActual<typeof import('../src/infrastructure/persistence.ts')>(
        '../src/infrastructure/persistence.ts',
      );

      return {
        ...actual,
        resolveStatePath: vi.fn(() => '/tmp/mrjmpl3-subagent-status-state.json'),
        resolveTextPath: vi.fn(() => '/tmp/mrjmpl3-subagent-status-status.txt'),
        loadState: vi.fn(async () => ({
          children: {
            ses_child: {
              id: 'ses_child',
              title: 'Persisted child',
              parentID: 'ses_parent',
              source: 'session',
              targetSessionID: 'ses_child',
              status: 'done',
              color: 'green',
              startedAt: '2026-06-04T11:55:00.000Z',
              updatedAt: '2026-06-04T12:00:00.000Z',
              endedAt: '2026-06-04T12:00:00.000Z',
            },
            'tool:ses_child': {
              id: 'tool:ses_child',
              title: 'Persisted child',
              parentID: 'ses_parent',
              source: 'tool',
              targetSessionID: 'ses_child',
              status: 'done',
              color: 'green',
              startedAt: '2026-06-04T11:55:00.000Z',
              updatedAt: '2026-06-04T12:00:00.000Z',
              endedAt: '2026-06-04T12:00:00.000Z',
            },
          },
          countedChildIDs: { ses_child: true },
          purgedSessionIDs: {},
          totalExecuted: 1,
          updatedAt: '2026-06-04T12:00:00.000Z',
        })),
        shouldPreserveStateOnStartup: vi.fn(() => true),
        createPersistQueue: vi.fn(() => async () => undefined),
      };
    });

    const { createTuiRuntime } = await import('../src/runtime/tui-runtime.ts');

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
                title: 'Persisted child',
                source: 'session',
                status: 'running',
                startedAt: '2026-06-04T11:55:00.000Z',
                updatedAt: '2026-06-04T12:01:00.000Z',
              },
            ],
          })),
          status: vi.fn(async () => ({ data: { ses_child: { type: 'running' } } })),
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
          messages: vi.fn(() => [{ time: { updated: '2026-06-04T12:01:00.000Z' } }]),
          status: vi.fn(() => ({ type: 'running' })),
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
    await waitForCondition(() => state.children.ses_child?.status === 'running');

    expect(state.children.ses_child).toMatchObject({
      status: 'running',
      color: 'yellow',
      updatedAt: '2026-06-04T12:01:00.000Z',
      endedAt: undefined,
    });
    expect(state.children['tool:ses_child']).toBeUndefined();

    runtime.dispose();
  });

  it('only probes stale running real session rows during refresh', async () => {
    vi.resetModules();

    vi.doMock('../src/infrastructure/persistence.ts', async () => {
      const actual = await vi.importActual<typeof import('../src/infrastructure/persistence.ts')>(
        '../src/infrastructure/persistence.ts',
      );

      return {
        ...actual,
        resolveStatePath: vi.fn(() => '/tmp/mrjmpl3-subagent-status-state.json'),
        resolveTextPath: vi.fn(() => '/tmp/mrjmpl3-subagent-status-status.txt'),
        loadState: vi.fn(async () => createEmptyState()),
        shouldPreserveStateOnStartup: vi.fn(() => false),
        createPersistQueue: vi.fn(() => async () => undefined),
      };
    });

    const { createTuiRuntime } = await import('../src/runtime/tui-runtime.ts');

    const statusSpy = vi.fn(async () => ({ data: {} }));
    const messagesSpy = vi.fn(async () => ({ data: [] }));

    let state: SubagentState = createEmptyState();
    let sessionID = '';
    const api = {
      client: {
        session: {
          children: vi.fn(async () => ({
            data: [
              {
                id: 'tool:delegate_1',
                parentID: 'ses_parent',
                title: 'Delegation wrapper',
                source: 'tool',
                targetSessionID: 'ses_child',
                status: 'running',
                startedAt: '2026-06-04T11:55:00.000Z',
                updatedAt: '2026-06-04T11:59:00.000Z',
              },
              {
                id: 'subtask:part_1',
                parentID: 'ses_parent',
                title: 'Synthetic fallback',
                source: 'subtask',
                targetSessionID: 'ses_child',
                status: 'running',
                startedAt: '2026-06-04T11:55:00.000Z',
                updatedAt: '2026-06-04T11:59:00.000Z',
              },
            ],
          })),
          status: statusSpy,
          messages: messagesSpy,
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
    await waitForCondition(() => state.children['subtask:part_1'] !== undefined);

    expect(state.children['tool:delegate_1']).toBeUndefined();
    expect(state.children['subtask:part_1']).toMatchObject({ status: 'running' });
    expect(statusSpy).not.toHaveBeenCalled();
    expect(messagesSpy).not.toHaveBeenCalled();

    runtime.dispose();
  });

  it('keeps children running when idle is the only evidence during refresh', async () => {
    vi.resetModules();

    vi.doMock('../src/infrastructure/persistence.ts', async () => {
      const actual = await vi.importActual<typeof import('../src/infrastructure/persistence.ts')>(
        '../src/infrastructure/persistence.ts',
      );

      return {
        ...actual,
        resolveStatePath: vi.fn(() => '/tmp/mrjmpl3-subagent-status-state.json'),
        resolveTextPath: vi.fn(() => '/tmp/mrjmpl3-subagent-status-status.txt'),
        loadState: vi.fn(async () => createEmptyState()),
        shouldPreserveStateOnStartup: vi.fn(() => false),
        createPersistQueue: vi.fn(() => async () => undefined),
      };
    });

    const { createTuiRuntime } = await import('../src/runtime/tui-runtime.ts');

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

  it('backs off stale-running probes when explicit completion evidence never arrives', async () => {
    vi.resetModules();
    const probePolicy = {
      baseBackoffMs: 1_000,
      maxBackoffMs: 4_000,
      maxAttempts: 4,
      refreshIntervalMs: 1_000,
    };

    vi.doMock('../src/infrastructure/persistence.ts', async () => {
      const actual = await vi.importActual<typeof import('../src/infrastructure/persistence.ts')>(
        '../src/infrastructure/persistence.ts',
      );

      return {
        ...actual,
        resolveStatePath: vi.fn(() => '/tmp/mrjmpl3-subagent-status-state.json'),
        resolveTextPath: vi.fn(() => '/tmp/mrjmpl3-subagent-status-status.txt'),
        loadState: vi.fn(async () => createEmptyState()),
        shouldPreserveStateOnStartup: vi.fn(() => false),
        createPersistQueue: vi.fn(() => async () => undefined),
      };
    });

    const { createTuiRuntime } = await import('../src/runtime/tui-runtime.ts');

    const statusSpy = vi.fn(async () => ({ data: { ses_child: { type: 'idle' } } }));
    const messagesSpy = vi.fn(async () => ({ data: [] }));

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
          status: statusSpy,
          messages: messagesSpy,
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

    const runtime = createTuiRuntime(
      api,
      {
        getState: () => state,
        setState: (nextState) => {
          state = nextState;
        },
        getSessionId: () => sessionID,
        setSessionId: (nextSessionID) => {
          sessionID = nextSessionID;
        },
        setNowMs: vi.fn(),
      },
      resolveSubagentStatusPluginOptions({ staleRunningProbePolicy: probePolicy }),
    );

    await runtime.bootstrap();
    runtime.refreshFromSlot({ session_id: 'ses_parent' });
    await waitForCondition(() => state.children.ses_child !== undefined);

    expect(statusSpy).toHaveBeenCalledTimes(1);
    expect(messagesSpy).toHaveBeenCalledTimes(1);
    expect(state.children.ses_child).toMatchObject({ status: 'running', endedAt: undefined });

    await vi.advanceTimersByTimeAsync(probePolicy.baseBackoffMs);
    await waitForCondition(() => statusSpy.mock.calls.length === 2);

    await vi.advanceTimersByTimeAsync(probePolicy.baseBackoffMs);
    expect(statusSpy).toHaveBeenCalledTimes(2);
    expect(messagesSpy).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(probePolicy.baseBackoffMs);
    await waitForCondition(() => statusSpy.mock.calls.length === 3);

    expect(messagesSpy).toHaveBeenCalledTimes(3);
    expect(state.children.ses_child).toMatchObject({ status: 'running', endedAt: undefined });

    runtime.dispose();
  });

  it('keeps children running when refresh only sees generic completedAt message evidence', async () => {
    vi.resetModules();

    vi.doMock('../src/infrastructure/persistence.ts', async () => {
      const actual = await vi.importActual<typeof import('../src/infrastructure/persistence.ts')>(
        '../src/infrastructure/persistence.ts',
      );

      return {
        ...actual,
        resolveStatePath: vi.fn(() => '/tmp/mrjmpl3-subagent-status-state.json'),
        resolveTextPath: vi.fn(() => '/tmp/mrjmpl3-subagent-status-status.txt'),
        loadState: vi.fn(async () => createEmptyState()),
        shouldPreserveStateOnStartup: vi.fn(() => false),
        createPersistQueue: vi.fn(() => async () => undefined),
      };
    });

    const { createTuiRuntime } = await import('../src/runtime/tui-runtime.ts');

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
    await waitForCondition(() => state.children.ses_child !== undefined);

    expect(state.children.ses_child).toMatchObject({
      status: 'running',
      endedAt: undefined,
    });

    runtime.dispose();
  });

  it('marks children done once explicit terminal session status arrives during refresh', async () => {
    vi.resetModules();

    vi.doMock('../src/infrastructure/persistence.ts', async () => {
      const actual = await vi.importActual<typeof import('../src/infrastructure/persistence.ts')>(
        '../src/infrastructure/persistence.ts',
      );

      return {
        ...actual,
        resolveStatePath: vi.fn(() => '/tmp/mrjmpl3-subagent-status-state.json'),
        resolveTextPath: vi.fn(() => '/tmp/mrjmpl3-subagent-status-status.txt'),
        loadState: vi.fn(async () => createEmptyState()),
        shouldPreserveStateOnStartup: vi.fn(() => false),
        createPersistQueue: vi.fn(() => async () => undefined),
      };
    });

    const { createTuiRuntime } = await import('../src/runtime/tui-runtime.ts');

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
          status: vi.fn(async () => ({
            data: {
              ses_child: {
                type: 'completed',
                time: {
                  completed: '2026-06-04T12:00:00.000Z',
                },
              },
            },
          })),
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
          status: vi.fn(() => ({
            type: 'completed',
            time: {
              completed: '2026-06-04T12:00:00.000Z',
            },
          })),
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
      color: 'green',
      endedAt: '2026-06-04T12:00:00.000Z',
    });

    runtime.dispose();
  });

  it('marks children done from strict step-finish message evidence during refresh', async () => {
    vi.resetModules();

    vi.doMock('../src/infrastructure/persistence.ts', async () => {
      const actual = await vi.importActual<typeof import('../src/infrastructure/persistence.ts')>(
        '../src/infrastructure/persistence.ts',
      );

      return {
        ...actual,
        resolveStatePath: vi.fn(() => '/tmp/mrjmpl3-subagent-status-state.json'),
        resolveTextPath: vi.fn(() => '/tmp/mrjmpl3-subagent-status-status.txt'),
        loadState: vi.fn(async () => createEmptyState()),
        shouldPreserveStateOnStartup: vi.fn(() => false),
        createPersistQueue: vi.fn(() => async () => undefined),
      };
    });

    const { createTuiRuntime } = await import('../src/runtime/tui-runtime.ts');

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
                type: 'step-finish',
                reason: 'stop',
                time: {
                  end: '2026-06-04T12:01:00.000Z',
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
              type: 'step-finish',
              reason: 'stop',
              time: {
                end: '2026-06-04T12:01:00.000Z',
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
      color: 'green',
      endedAt: '2026-06-04T12:01:00.000Z',
    });

    runtime.dispose();
  });

  it('treats queued client status as running during refresh hydration', async () => {
    vi.resetModules();

    vi.doMock('../src/infrastructure/persistence.ts', async () => {
      const actual = await vi.importActual<typeof import('../src/infrastructure/persistence.ts')>(
        '../src/infrastructure/persistence.ts',
      );

      return {
        ...actual,
        resolveStatePath: vi.fn(() => '/tmp/mrjmpl3-subagent-status-state.json'),
        resolveTextPath: vi.fn(() => '/tmp/mrjmpl3-subagent-status-status.txt'),
        loadState: vi.fn(async () => createEmptyState()),
        shouldPreserveStateOnStartup: vi.fn(() => false),
        createPersistQueue: vi.fn(() => async () => undefined),
      };
    });

    const { createTuiRuntime } = await import('../src/runtime/tui-runtime.ts');

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
                title: 'Queued child',
                source: 'session',
                status: 'running',
                startedAt: '2026-06-04T11:55:00.000Z',
                updatedAt: '2026-06-04T11:59:00.000Z',
              },
            ],
          })),
          status: vi.fn(async () => ({ data: { ses_child: { type: 'queued' } } })),
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
          status: vi.fn(() => ({ type: 'queued' })),
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
});
