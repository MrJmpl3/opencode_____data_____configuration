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

    vi.doMock('../sources/events.ts', async () => {
      const actual = await vi.importActual<typeof import('../sources/events.ts')>('../sources/events.ts');

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

    vi.doMock('../storage/persistence.ts', async () => {
      const actual = await vi.importActual<typeof import('../storage/persistence.ts')>('../storage/persistence.ts');
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
          (..._args: [string, string]) =>
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
});
