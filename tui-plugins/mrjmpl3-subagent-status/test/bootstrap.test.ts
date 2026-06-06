import type { TuiPluginApi } from '@opencode-ai/plugin/tui';
import { describe, expect, it, vi } from 'vitest';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

describe('tui bootstrap buffering', () => {
  it('buffers early bridge events until the initial snapshot write completes', async () => {
    vi.resetModules();

    const firstSaveGate = deferred<void>();
    const saveStateCalls: Array<{ children: string[] }> = [];
    let saveStateCount = 0;
    let capturedOnEvent: ((event: unknown) => void) | undefined;
    let bridgeDisposeCount = 0;
    const lifecycleDisposers: Array<() => void> = [];

    vi.doMock('../src/runtime/events/bridge.ts', async () => {
      const actual = await vi.importActual<typeof import('../src/runtime/events/bridge.ts')>(
        '../src/runtime/events/bridge.ts',
      );

      return {
        ...actual,
        installEventBridge: vi.fn((api, _refresh, onEvent) => {
          capturedOnEvent = onEvent;
          const dispose = () => {
            bridgeDisposeCount += 1;
            capturedOnEvent = undefined;
          };
          api.lifecycle.onDispose(dispose);
          return dispose;
        }),
      };
    });

    vi.doMock('../src/infrastructure/persistence.ts', async () => {
      const actual = await vi.importActual<typeof import('../src/infrastructure/persistence.ts')>(
        '../src/infrastructure/persistence.ts',
      );
      const saveState = vi.fn(async (_path: string, state: { children: Record<string, unknown> }) => {
        saveStateCount += 1;
        saveStateCalls.push({ children: Object.keys(state.children) });

        if (saveStateCount === 1) {
          await firstSaveGate.promise;
        }
      });
      const saveStatusText = vi.fn(async (_path: string, _contents: string) => undefined);

      return {
        ...actual,
        resolveStatePath: vi.fn(() => '/tmp/mrjmpl3-subagent-status-state.json'),
        resolveTextPath: vi.fn(() => '/tmp/mrjmpl3-subagent-status-status.txt'),
        saveState,
        saveStatusText,
        createPersistQueue: vi.fn(
          (..._args: [string, string, unknown]) =>
            async (state: { children: Record<string, unknown> }, _meta: unknown) => {
              await saveState('/tmp/mrjmpl3-subagent-status-state.json', state);
              await saveStatusText('/tmp/mrjmpl3-subagent-status-status.txt', '');
            },
        ),
        shouldPreserveStateOnStartup: vi.fn(() => false),
      };
    });

    const { default: plugin } = await import('../index.tsx');

    const api = {
      client: {
        session: {
          children: vi.fn(async () => ({ data: [] })),
        },
      },
      lifecycle: {
        onDispose: (handler: () => void) => {
          lifecycleDisposers.push(handler);
        },
      },
      route: {
        navigate: vi.fn(),
      },
      slots: {
        register: vi.fn(),
      },
      state: {
        path: {
          directory: '/tmp/workspace',
        },
      },
      theme: {
        current: {
          error: 'red',
          success: 'green',
          text: 'white',
          textMuted: 'gray',
          warning: 'yellow',
        },
      },
    } as unknown as TuiPluginApi;

    await plugin.tui(api, undefined, undefined as never);
    expect(capturedOnEvent).toBeTypeOf('function');

    capturedOnEvent?.({
      type: 'session.created',
      properties: {
        info: {
          id: 'ses_early',
          parentID: 'ses_parent',
          title: 'Early child',
        },
      },
    });

    await Promise.resolve();
    expect(saveStateCalls).toEqual([{ children: [] }]);

    for (const dispose of lifecycleDisposers) {
      dispose();
    }

    expect(bridgeDisposeCount).toBe(1);
    expect(capturedOnEvent).toBeUndefined();

    firstSaveGate.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(saveStateCalls).toEqual([{ children: [] }]);

    capturedOnEvent?.({
      type: 'session.created',
      properties: {
        info: {
          id: 'ses_late',
          parentID: 'ses_parent',
          title: 'Late child',
        },
      },
    });

    await Promise.resolve();
    expect(saveStateCalls).toEqual([{ children: [] }]);
  });

  it('accepts explicit plugin tuple options and normalizes them before bootstrap', async () => {
    vi.resetModules();

    const resolveStatePath = vi.fn(() => '/tmp/custom-subagent-status.json');
    const resolveTextPath = vi.fn(() => '/tmp/custom-subagent-status.txt');
    const loadState = vi.fn(async () => ({
      children: {},
      countedChildIDs: {},
      purgedSessionIDs: {},
      totalExecuted: 0,
      updatedAt: '2026-06-04T12:00:00.000Z',
    }));
    const shouldPreserveStateOnStartup = vi.fn(({ preserveStateOnStartup }: { preserveStateOnStartup?: boolean }) =>
      preserveStateOnStartup === true,
    );
    const createSQLiteRecoverySource = vi.fn(() => ({
      id: 'sqlite',
      hydrate: vi.fn(async () => ({ changed: false })),
    }));

    vi.doMock('../src/infrastructure/persistence.ts', async () => {
      const actual = await vi.importActual<typeof import('../src/infrastructure/persistence.ts')>(
        '../src/infrastructure/persistence.ts',
      );

      return {
        ...actual,
        resolveStatePath,
        resolveTextPath,
        loadState,
        shouldPreserveStateOnStartup,
        createPersistQueue: vi.fn(() => async () => undefined),
      };
    });

    vi.doMock('../src/infrastructure/recovery/sqlite.ts', () => ({
      createSQLiteRecoverySource,
    }));

    const { default: plugin, DEFAULT_STALE_RUNNING_PROBE_POLICY } = await import('../index.tsx');

    const api = {
      client: {
        session: {
          children: vi.fn(async () => ({ data: [] })),
        },
      },
      lifecycle: {
        onDispose: vi.fn(),
      },
      route: {
        navigate: vi.fn(),
        current: { name: 'home' },
      },
      slots: {
        register: vi.fn(),
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
      theme: {
        current: {
          error: 'red',
          success: 'green',
          text: 'white',
          textMuted: 'gray',
          warning: 'yellow',
        },
      },
    } as unknown as TuiPluginApi;

    await plugin.tui(
      api,
      {
        staleRunningProbePolicy: {
          baseBackoffMs: 10,
          maxBackoffMs: 20,
          maxAttempts: 2,
          refreshIntervalMs: 30,
        },
        persistence: {
          statePath: ' /tmp/from-options.json ',
          preserveStateOnStartup: true,
        },
        recovery: {
          sqliteDatabasePath: ' /tmp/opencode.db ',
        },
      },
      undefined as never,
    );

    expect(resolveStatePath).toHaveBeenCalledWith({
      workspaceDirectory: '/tmp/workspace',
      statePath: '/tmp/from-options.json',
    });
    expect(shouldPreserveStateOnStartup).toHaveBeenCalledWith({ preserveStateOnStartup: true });
    expect(loadState).toHaveBeenCalledWith('/tmp/custom-subagent-status.json');
    expect(createSQLiteRecoverySource).toHaveBeenCalledWith({ databasePath: '/tmp/opencode.db' });
    expect(DEFAULT_STALE_RUNNING_PROBE_POLICY.baseBackoffMs).toBe(60_000);
  });
});
