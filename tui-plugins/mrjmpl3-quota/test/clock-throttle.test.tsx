/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from '@opencode-ai/plugin/tui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountRuntimeHarness, type QuotaRuntimeHarness, type SignalSpy } from '@mrjmpl3/tui-kit/test';

/**
 * Build an isolated quota runtime harness with a mocked Solid signal layer so
 * `setNowMs` / `setLines` calls are observable as Vitest mocks. Each call gets
 * its own module registry so `vi.doMock` mocks never leak between tests.
 */
const setupHarness = async (fetchProviderLines: ReturnType<typeof vi.fn>): Promise<QuotaRuntimeHarness> => {
  vi.resetModules();

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

  return mountRuntimeHarness(
    registerQuotaTui,
    signals,
    {
      minRefreshIntervalMs: 600_000,
      pollIntervalMs: 0,
      providerCacheTtlMs: 600_000,
      visibleProviders: ['openrouter'],
    },
  );
};

describe('quota clock throttle', () => {
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

  // Q-1 Hidden: sidebar slot never mounted -> clock paused -> 0 setNowMs in 10s.
  it('does not call setNowMs while the sidebar slot is not mounted', async () => {
    const harness = await setupHarness(vi.fn(async () => ['OpenRouter ready']));
    harness.setNowMs.mockClear();

    vi.advanceTimersByTime(10_000);

    expect(harness.setNowMs).not.toHaveBeenCalled();

    harness.dispose();
  });

  // Q-2 Empty: slot mounted but no visible lines -> content gate pauses clock.
  it('does not call setNowMs while the slot is mounted but lines are empty', async () => {
    const harness = await setupHarness(vi.fn(async () => ['OpenRouter ready']));
    harness.mountSlot({});
    harness.setLines([]);
    harness.setNowMs.mockClear();

    vi.advanceTimersByTime(10_000);

    expect(harness.setNowMs).not.toHaveBeenCalled();

    harness.dispose();
  });

  // Q-5 Ticking: slot mounted and lines visible -> clock fires once per second.
  it('calls setNowMs once per second while the slot is mounted and lines are visible', async () => {
    const harness = await setupHarness(vi.fn(async () => ['OpenRouter ready']));
    harness.mountSlot({});
    harness.setNowMs.mockClear();

    vi.advanceTimersByTime(2_000);

    expect(harness.setNowMs).toHaveBeenCalledTimes(2);

    harness.dispose();
  });

  // Q-3 Resume: a hidden slot that becomes visible resumes the clock immediately.
  it('resumes the clock immediately when a hidden slot becomes visible', async () => {
    const harness = await setupHarness(vi.fn(async () => ['OpenRouter ready']));
    // Exclude the initial refresh's setNowMs (expected, not a clock tick).
    harness.setNowMs.mockClear();

    vi.advanceTimersByTime(10_000);
    expect(harness.setNowMs).not.toHaveBeenCalled();

    harness.mountSlot({});
    expect(harness.setNowMs).toHaveBeenCalled();

    harness.setNowMs.mockClear();
    vi.advanceTimersByTime(2_000);
    expect(harness.setNowMs).toHaveBeenCalledTimes(2);

    harness.dispose();
  });
});
