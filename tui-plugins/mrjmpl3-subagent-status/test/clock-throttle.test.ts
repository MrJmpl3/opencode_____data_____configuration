import type { TuiPluginApi } from '@opencode-ai/plugin/tui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEmptyState } from '../src/domain/state.ts';
import type { SubagentState } from '../src/domain/types.ts';

/**
 * Build a TuiRuntime against a stubbed API with a spied `setNowMs` and a
 * controllable `hasVisibleContent` gate, so clock-tick behavior is observable
 * without mounting the full Solid view. The persistence layer is mocked so no
 * disk I/O happens.
 */
const setupRuntime = async (overrides?: {
  hasVisibleContent?: () => boolean;
}): Promise<{
  setNowMs: ReturnType<typeof vi.fn>;
  setSlotVisible: (visible: boolean) => void;
  setVisibleContent: (visible: boolean) => void;
  dispose: () => void;
}> => {
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
  let visibleContent = false;
  const setNowMs = vi.fn();

  const api = {
    client: {
      session: {
        children: vi.fn(async () => ({ data: [] })),
      },
    },
    event: {
      on: vi.fn(() => vi.fn()),
    },
    lifecycle: {
      onDispose: vi.fn(),
    },
    state: {
      path: { directory: '/tmp/workspace' },
      session: {
        messages: vi.fn(() => []),
        status: vi.fn(() => undefined),
      },
    },
  } as unknown as TuiPluginApi;

  const runtime = createTuiRuntime(api, {
    getState: () => state,
    setState: (nextState: SubagentState) => {
      state = nextState;
    },
    getSessionId: () => sessionID,
    setSessionId: (nextSessionID: string) => {
      sessionID = nextSessionID;
    },
    setNowMs,
    hasVisibleContent: overrides?.hasVisibleContent ?? (() => visibleContent),
  });

  return {
    setNowMs,
    setSlotVisible: (visible: boolean) => runtime.setSlotVisible(visible),
    setVisibleContent: (visible: boolean) => {
      visibleContent = visible;
    },
    dispose: () => runtime.dispose(),
  };
};

describe('subagent-status clock throttle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-04T05:25:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock('../src/infrastructure/persistence.ts');
    vi.resetModules();
  });

  // S-1 Hidden: slot not visible -> clock paused -> 0 setNowMs in 10s.
  it('does not call setNowMs while the slot is hidden', async () => {
    const harness = await setupRuntime();
    harness.setSlotVisible(false);
    harness.setNowMs.mockClear();

    vi.advanceTimersByTime(10_000);

    expect(harness.setNowMs).not.toHaveBeenCalled();

    harness.dispose();
  });

  // S-2 Empty: slot visible but no active/recent children -> 0 setNowMs in 10s.
  it('does not call setNowMs while the slot is visible but there are no visible children', async () => {
    const harness = await setupRuntime();
    harness.setSlotVisible(true);
    harness.setVisibleContent(false);
    harness.setNowMs.mockClear();

    vi.advanceTimersByTime(10_000);

    expect(harness.setNowMs).not.toHaveBeenCalled();

    harness.dispose();
  });

  // S-3 Child resume: no children -> child becomes active -> clock resumes within 1s.
  it('resumes the clock within 1s when a child becomes visible', async () => {
    const harness = await setupRuntime();
    harness.setSlotVisible(true);
    harness.setVisibleContent(false);
    harness.setNowMs.mockClear();

    vi.advanceTimersByTime(10_000);
    expect(harness.setNowMs).not.toHaveBeenCalled();

    harness.setVisibleContent(true);
    vi.advanceTimersByTime(1_000);

    expect(harness.setNowMs).toHaveBeenCalled();

    harness.dispose();
  });

  // S-4 Visibility resume: children exist but slot hidden -> becomes visible -> clock resumes within 1s.
  it('resumes the clock within 1s when a hidden slot with children becomes visible', async () => {
    const harness = await setupRuntime();
    harness.setSlotVisible(false);
    harness.setVisibleContent(true);
    harness.setNowMs.mockClear();

    vi.advanceTimersByTime(10_000);
    expect(harness.setNowMs).not.toHaveBeenCalled();

    harness.setSlotVisible(true);
    vi.advanceTimersByTime(1_000);

    expect(harness.setNowMs).toHaveBeenCalled();

    harness.dispose();
  });

  // Ticking: slot visible + children -> clock fires once per second.
  it('calls setNowMs once per second while visible with children', async () => {
    const harness = await setupRuntime();
    harness.setSlotVisible(true);
    harness.setVisibleContent(true);
    harness.setNowMs.mockClear();

    vi.advanceTimersByTime(2_000);

    expect(harness.setNowMs).toHaveBeenCalledTimes(2);

    harness.dispose();
  });
});
