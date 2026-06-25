/** @jsxImportSource @opentui/solid */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountRuntimeHarness, type QuotaRuntimeHarness, type SignalSpy } from '@mrjmpl3/tui-kit/test';

const flushAsyncTasks = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

describe('quota setLines batch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock('solid-js');
    vi.doUnmock('@opentui/solid');
    vi.doUnmock('@opentui/solid/jsx-runtime');
    vi.doUnmock('@opentui/solid/jsx-dev-runtime');
    vi.doUnmock('../src/domain/provider-results.ts');
    vi.resetModules();
  });

  // Q-4 Batch: a 3-provider refresh produces exactly one setLines during
  // settlement, regardless of how many providers finish.
  it('calls setLines exactly once after all providers settle in a single refresh cycle', async () => {
    vi.resetModules();

    const resolvers: Record<string, (value: string) => void> = {};
    const fetchProviderLines = vi.fn((opts: { providerId: string }) =>
      new Promise<string>((resolve) => {
        resolvers[opts.providerId] = resolve;
      }),
    );

    const signals: SignalSpy[] = [];
    vi.doMock('solid-js', () => ({
      createSignal: <T,>(initial: T) => {
        let value = initial;
        const get = () => value;
        const set = vi.fn((next: unknown) => {
          value = next as T;
        });
        signals.push({ get, set });
        return [get, set] as const;
      },
      Show: (props: { when: boolean; fallback?: unknown; children?: unknown }) =>
        props.when ? props.children : props.fallback,
      onCleanup: () => undefined,
    }));
    vi.doMock('@opentui/solid', () => ({
      Fragment: (props: { children?: unknown }) => props.children,
      jsx: () => null,
      jsxs: () => null,
      jsxDEV: () => null,
    }));
    vi.doMock('@opentui/solid/jsx-runtime', () => ({
      Fragment: (props: { children?: unknown }) => props.children,
      jsx: () => null,
      jsxs: () => null,
      jsxDEV: () => null,
    }));
    vi.doMock('@opentui/solid/jsx-dev-runtime', () => ({
      Fragment: (props: { children?: unknown }) => props.children,
      jsx: () => null,
      jsxs: () => null,
      jsxDEV: () => null,
    }));
    vi.doMock('../src/domain/provider-results.ts', async () => {
      const actual = await vi.importActual<typeof import('../src/domain/provider-results.ts')>(
        '../src/domain/provider-results.ts',
      );
      return { ...actual, fetchProviderLines };
    });

    const { registerQuotaTui } = await import('../src/runtime/runtime.tsx');
    const harness: QuotaRuntimeHarness = await mountRuntimeHarness(
      registerQuotaTui,
      signals,
      {
        minRefreshIntervalMs: 600_000,
        pollIntervalMs: 0,
        providerCacheTtlMs: 600_000,
        visibleProviders: ['openrouter', 'github-copilot', 'openai'],
      },
    );

    // The initial cached display setLines happens before providers settle.
    // Reset the spy so only settlement-phase calls are counted.
    harness.setLines.mockClear();

    // Resolve all three providers in one cycle.
    resolvers.openrouter?.('openrouter-ready');
    resolvers['github-copilot']?.('copilot-ready');
    resolvers.openai?.('openai-ready');
    await flushAsyncTasks();

    expect(harness.setLines).toHaveBeenCalledTimes(1);

    harness.dispose();
  });
});
