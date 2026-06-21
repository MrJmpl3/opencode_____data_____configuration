import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { TuiPluginApi, TuiPluginMeta } from '@opencode-ai/plugin/tui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as quotaIndex from '../index.tsx';
import plugin, {
  formatResponsibleWeeklyUsage,
  isQuotaRateLimitError,
  resolveQuotaPluginOptions,
  retryAfterMsFromMessage,
} from '../index.tsx';
import { inspectQuotaPluginOptions } from '../src/runtime/options.ts';
import { createRefreshScheduler } from '../src/runtime/refresh-scheduler.ts';
import { detailTextLine, headingLine } from '../src/domain/lines.ts';
import {
  isQuotaTerminalSessionEvent,
  isQuotaTerminalTaskEvent,
  registerQuotaTui,
  refreshQuotaProviders,
  shouldKeepDeferredRefreshTimer,
} from '../src/runtime/runtime.tsx';
import { fetchCopilotQuota, normalizeCopilotResetAtMs } from '../src/infrastructure/providers/copilot.ts';
import { fmtDuration } from '../src/infrastructure/providers/format.ts';
import { fetchWithTimeout } from '../src/infrastructure/providers/http.ts';
import {
  fetchOpenAIQuota,
  parseAdditionalRateLimits,
  parseResetCreditsPayload,
} from '../src/infrastructure/providers/openai.ts';
import { fetchOpenRouterQuota as fetchOpenRouterQuotaFromOpenRouter } from '../src/infrastructure/providers/openrouter.ts';
import { fetchOpenAIQuota as fetchOpenAIQuotaFromOpenAI } from '../src/infrastructure/providers/openai.ts';
import { fetchOpenRouterQuota } from '../src/infrastructure/providers/openrouter.ts';
import { fetchWithTimeout as fetchWithTimeoutFromHttp } from '../src/infrastructure/providers/http.ts';
import { fmtDuration as fmtDurationFromProviderFormat } from '../src/infrastructure/providers/format.ts';
import { parseAdditionalRateLimits as parseAdditionalRateLimitsFromOpenAI } from '../src/infrastructure/providers/openai.ts';

const createAuthFixture = (entries: Record<string, unknown>): string => {
  const root = mkdtempSync(join(tmpdir(), 'opencode-quota-'));
  const authDir = join(root, 'opencode');
  mkdirSync(authDir, { recursive: true });
  writeFileSync(join(authDir, 'auth.json'), JSON.stringify(entries), 'utf8');
  return root;
};

const flushAsyncTasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const pluginMeta: TuiPluginMeta = {
  id: 'quota',
  source: 'file',
  spec: 'quota',
  target: 'quota',
  first_time: 0,
  last_time: 0,
  time_changed: 0,
  load_count: 1,
  fingerprint: 'test',
  state: 'first',
};

describe('quota tui plugin', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('exposes a stable plugin contract', () => {
    expect(plugin.id).toBe('quota');
    expect(typeof plugin.tui).toBe('function');
  });

  it('keeps the current index export surface available', () => {
    expect(quotaIndex.default.id).toBe('quota');
    expect(typeof quotaIndex.formatResponsibleUsagePace).toBe('function');
    expect(typeof quotaIndex.formatResponsibleWeeklyUsage).toBe('function');
    expect(typeof quotaIndex.isQuotaRateLimitError).toBe('function');
    expect(typeof quotaIndex.resolveQuotaPluginOptions).toBe('function');
    expect(typeof quotaIndex.retryAfterMsFromMessage).toBe('function');
  });

  it('returns defaults when plugin options are omitted', () => {
    const options = resolveQuotaPluginOptions(undefined);

    expect(options).toEqual({
      displayMode: 'remaining',
      visibleProviders: [
        { id: 'opencode-go', label: 'OpenCode Go' },
        { id: 'github-copilot', label: 'GitHub Copilot' },
        { id: 'openrouter', label: 'OpenRouter' },
      ],
      pollIntervalMs: 600_000,
      minRefreshIntervalMs: 120_000,
      providerCacheTtlMs: 300_000,
      providerErrorBackoffMs: 900_000,
      experimentalOpenAIResetCredits: false,
    });
  });

  it('rejects legacy provider ids and falls back to defaults when nothing valid remains', () => {
    const options = resolveQuotaPluginOptions({
      visibleProviders: [' OR ', 'copilot', 'go', 'unknown', 'chatgpt'],
    });

    expect(options.visibleProviders).toEqual([
      { id: 'opencode-go', label: 'OpenCode Go' },
      { id: 'github-copilot', label: 'GitHub Copilot' },
      { id: 'openrouter', label: 'OpenRouter' },
    ]);
  });

  it('reports invalid visibleProviders entries without changing canonical selection rules', () => {
    const resolved = inspectQuotaPluginOptions({
      visibleProviders: ['openai', 'copilot', 'go', 'or', 'openai', 42],
    });

    expect(resolved.options.visibleProviders).toEqual([{ id: 'openai', label: 'OpenAI' }]);
    expect(resolved.diagnostics).toEqual({
      invalidVisibleProviderEntries: ['"copilot"', '"go"', '"or"', '42'],
      fellBackToDefaultVisibleProviders: false,
    });
  });

  it('accepts canonical provider ids and preserves their configured order', () => {
    const options = resolveQuotaPluginOptions({
      visibleProviders: ['openai', 'opencode-go', 'github-copilot'],
    });

    expect(options.visibleProviders).toEqual([
      { id: 'openai', label: 'OpenAI' },
      { id: 'opencode-go', label: 'OpenCode Go' },
      { id: 'github-copilot', label: 'GitHub Copilot' },
    ]);
  });

  it('keeps the first duplicate canonical provider and does not reorder the output', () => {
    const options = resolveQuotaPluginOptions({
      visibleProviders: ['openai', 'opencode-go', 'openai', 'github-copilot', 'opencode-go'],
    });

    expect(options.visibleProviders).toEqual([
      { id: 'openai', label: 'OpenAI' },
      { id: 'opencode-go', label: 'OpenCode Go' },
      { id: 'github-copilot', label: 'GitHub Copilot' },
    ]);
  });

  it('normalizes numeric plugin options without changing canonical provider order', () => {
    const options = resolveQuotaPluginOptions({
      displayMode: 'used',
      visibleProviders: ['openai', 'openrouter', 'openai'],
      pollIntervalMs: 0,
      minRefreshIntervalMs: 10,
      providerCacheTtlMs: 20,
      providerErrorBackoffMs: Number.NaN,
    });

    expect(options).toEqual({
      displayMode: 'used',
      visibleProviders: [
        { id: 'openai', label: 'OpenAI' },
        { id: 'openrouter', label: 'OpenRouter' },
      ],
      pollIntervalMs: 0,
      minRefreshIntervalMs: 60_000,
      providerCacheTtlMs: 60_000,
      providerErrorBackoffMs: 900_000,
      experimentalOpenAIResetCredits: false,
    });
  });

  it('exposes provider adapters from their responsibility-based modules', () => {
    expect(fetchCopilotQuota).toBeDefined();
    expect(fetchWithTimeout).toBe(fetchWithTimeoutFromHttp);
    expect(fetchOpenAIQuota).toBe(fetchOpenAIQuotaFromOpenAI);
    expect(fetchOpenRouterQuota).toBe(fetchOpenRouterQuotaFromOpenRouter);
    expect(fmtDuration).toBe(fmtDurationFromProviderFormat);
    expect(parseAdditionalRateLimits).toBe(parseAdditionalRateLimitsFromOpenAI);
  });

  it('registers a sidebar slot, responds to session changes, and disposes timers/events', async () => {
    const events = new Map<string, (payload?: unknown) => void>();
    const disposers: (() => void)[] = [];
    const slotRegistrations: { slots: { sidebar_content: (ctx: unknown, slotInput: unknown) => unknown } }[] = [];

    const api = {
      event: {
        on: (eventName: string, handler: (payload?: unknown) => void) => {
          events.set(eventName, handler);
          return () => events.delete(eventName);
        },
      },
      lifecycle: {
        onDispose: (handler: () => void) => disposers.push(handler),
      },
      slots: {
        register: (registration: { slots: { sidebar_content: (ctx: unknown, slotInput: unknown) => unknown } }) => {
          slotRegistrations.push(registration);
        },
      },
      theme: { current: { text: 'white', textMuted: 'gray' } },
    } as unknown as TuiPluginApi;

    await plugin.tui(
      api,
      {
        minRefreshIntervalMs: 60_000,
        pollIntervalMs: 0,
        providerCacheTtlMs: 60_000,
        visibleProviders: ['openrouter'],
      },
      pluginMeta,
    );

    expect(slotRegistrations).toHaveLength(1);
    expect(events.has('message.part.updated')).toBe(true);
    expect(events.has('session.error')).toBe(true);
    expect(events.has('session.status')).toBe(true);
    expect(events.has('tui.session.select')).toBe(true);
    expect(events.has('session.idle')).toBe(true);

    disposers.forEach((dispose) => dispose());
    await vi.runAllTimersAsync();
    expect(events.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('warns once when visibleProviders contains invalid entries', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const events = new Map<string, (payload?: unknown) => void>();
    const disposers: (() => void)[] = [];
    const slotRegistrations: { slots: { sidebar_content: (ctx: unknown, slotInput: unknown) => unknown } }[] = [];

    const api = {
      event: {
        on: (eventName: string, handler: (payload?: unknown) => void) => {
          events.set(eventName, handler);
          return () => events.delete(eventName);
        },
      },
      lifecycle: {
        onDispose: (handler: () => void) => disposers.push(handler),
      },
      slots: {
        register: (registration: { slots: { sidebar_content: (ctx: unknown, slotInput: unknown) => unknown } }) => {
          slotRegistrations.push(registration);
        },
      },
      theme: { current: { text: 'white', textMuted: 'gray' } },
    } as unknown as TuiPluginApi;

    await registerQuotaTui(api, {
      minRefreshIntervalMs: 60_000,
      pollIntervalMs: 0,
      providerCacheTtlMs: 60_000,
      visibleProviders: ['copilot', 'openrouter', 'chatgpt'],
    });

    await flushAsyncTasks();

    expect(slotRegistrations).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      '[quota] Ignoring invalid visibleProviders entries: "copilot", "chatgpt". ' +
        'Allowed canonical provider ids: opencode-go, github-copilot, openrouter, openai.',
    );

    events.get('session.idle')?.();
    await flushAsyncTasks();

    expect(warnSpy).toHaveBeenCalledTimes(1);

    disposers.forEach((dispose) => dispose());
  });

  it('coalesces repeated immediate refresh events before execution', () => {
    const events = new Map<string, (payload?: unknown) => void>();
    const onRefresh = vi.fn();
    const scheduler = createRefreshScheduler({
      subscribe: (eventName, handler) => {
        events.set(eventName, handler);
        return () => events.delete(eventName);
      },
      onRefresh,
      immediateEvents: ['now'],
      completionEvents: [],
      pollIntervalMs: 0,
      refreshDelayMs: 250,
    });

    events.get('now')?.();
    events.get('now')?.();
    events.get('now')?.();
    events.get('now')?.();
    vi.advanceTimersByTime(249);
    expect(onRefresh).toHaveBeenCalledTimes(0);

    events.get('now')?.();
    vi.advanceTimersByTime(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledWith('now');

    scheduler.dispose();
  });

  it('recognizes terminal subagent completion events without reacting to non-terminal noise', () => {
    expect(
      isQuotaTerminalTaskEvent({
        properties: {
          part: {
            type: 'tool',
            tool: 'task',
            state: {
              status: 'completed',
            },
          },
        },
      }),
    ).toBe(true);

    expect(
      isQuotaTerminalTaskEvent({
        properties: {
          part: {
            type: 'tool',
            tool: 'task',
            state: {
              status: 'running',
            },
          },
        },
      }),
    ).toBe(false);

    expect(
      isQuotaTerminalSessionEvent({
        properties: {
          state: {
            status: 'completed',
          },
        },
      }),
    ).toBe(true);

    expect(
      isQuotaTerminalSessionEvent({
        properties: {
          status: 'running',
        },
      }),
    ).toBe(false);
  });

  it('filters non-terminal task updates before scheduling completion refreshes', () => {
    const events = new Map<string, (payload?: unknown) => void>();
    const onRefresh = vi.fn();
    const scheduler = createRefreshScheduler({
      subscribe: (eventName, handler) => {
        events.set(eventName, handler);
        return () => events.delete(eventName);
      },
      onRefresh,
      immediateEvents: [],
      completionEvents: [{ name: 'message.part.updated', shouldRefresh: isQuotaTerminalTaskEvent }],
      pollIntervalMs: 0,
      refreshDelayMs: 300,
    });

    events.get('message.part.updated')?.({
      properties: {
        part: {
          type: 'tool',
          tool: 'task',
          state: {
            status: 'running',
          },
        },
      },
    });
    vi.advanceTimersByTime(600);
    expect(onRefresh).toHaveBeenCalledTimes(0);

    events.get('message.part.updated')?.({
      properties: {
        part: {
          type: 'tool',
          tool: 'task',
          state: {
            status: 'completed',
          },
        },
      },
    });
    vi.advanceTimersByTime(549);
    expect(onRefresh).toHaveBeenCalledTimes(0);

    vi.advanceTimersByTime(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledWith('message.part.updated');

    scheduler.dispose();
  });

  it('coalesces terminal subagent bursts into one forced provider refetch per refresh interval', async () => {
    vi.resetModules();

    const fetchProviderLines = vi.fn(async () => ['OpenRouter ready']);

    vi.doMock('../src/domain/provider-results.ts', async () => {
      const actual = await vi.importActual<typeof import('../src/domain/provider-results.ts')>(
        '../src/domain/provider-results.ts',
      );

      return {
        ...actual,
        fetchProviderLines,
      };
    });

    const { registerQuotaTui } = await import('../src/runtime/runtime.tsx');
    const events = new Map<string, (payload?: unknown) => void>();
    const disposers: Array<() => void> = [];
    const slotRegistrations: { slots: { sidebar_content: (ctx: unknown, slotInput: unknown) => unknown } }[] = [];

    const api = {
      event: {
        on: (eventName: string, handler: (payload?: unknown) => void) => {
          events.set(eventName, handler);
          return () => events.delete(eventName);
        },
      },
      lifecycle: {
        onDispose: (handler: () => void) => disposers.push(handler),
      },
      slots: {
        register: (registration: { slots: { sidebar_content: (ctx: unknown, slotInput: unknown) => unknown } }) => {
          slotRegistrations.push(registration);
        },
      },
      theme: { current: { text: 'white', textMuted: 'gray' } },
    } as unknown as TuiPluginApi;

    await registerQuotaTui(api, {
      minRefreshIntervalMs: 60_000,
      pollIntervalMs: 0,
      providerCacheTtlMs: 300_000,
      visibleProviders: ['openrouter'],
    });
    await flushAsyncTasks();

    expect(fetchProviderLines).toHaveBeenCalledTimes(1);

    const emitTerminalTaskCompletion = () => {
      events.get('message.part.updated')?.({
        properties: {
          part: {
            type: 'tool',
            tool: 'task',
            state: {
              status: 'completed',
            },
          },
        },
      });
    };

    emitTerminalTaskCompletion();
    vi.advanceTimersByTime(549);
    await flushAsyncTasks();
    expect(fetchProviderLines).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    await flushAsyncTasks();
    expect(fetchProviderLines).toHaveBeenCalledTimes(2);

    emitTerminalTaskCompletion();
    events.get('session.status')?.({
      properties: {
        state: {
          status: 'completed',
        },
      },
    });
    events.get('session.error')?.({
      properties: {
        sessionID: 'ses_child',
      },
    });

    vi.advanceTimersByTime(550);
    await flushAsyncTasks();
    expect(fetchProviderLines).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(59_449);
    await flushAsyncTasks();
    expect(fetchProviderLines).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(1);
    await flushAsyncTasks();
    expect(fetchProviderLines).toHaveBeenCalledTimes(3);

    disposers.forEach((dispose) => dispose());
    vi.doUnmock('../src/domain/provider-results.ts');
    vi.resetModules();
  });

  it('clears visible stale provider results when an invalidating refresh request lands mid-flight, even if the stale fetch resolves before the deferred refresh starts', async () => {
    vi.resetModules();

    const resolvers: Array<(value: unknown) => void> = [];
    const fetchProviderLines = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const signals: Array<{ get: () => unknown; set: (value: unknown) => void }> = [];

    vi.doMock('solid-js', () => ({
      createSignal: <T>(initial: T) => {
        let value = initial;
        const get = () => value;
        const set = (next: unknown) => {
          value = next as T;
        };

        signals.push({ get, set });
        return [get, set] as const;
      },
      Show: (props: { when: boolean; fallback?: unknown; children?: unknown }) =>
        props.when ? props.children : props.fallback,
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

      return {
        ...actual,
        fetchProviderLines,
      };
    });

    const { registerQuotaTui } = await import('../src/runtime/runtime.tsx');
    const events = new Map<string, (payload?: unknown) => void>();
    const disposers: Array<() => void> = [];
    const slotRegistrations: { slots: { sidebar_content: (ctx: unknown, slotInput: unknown) => unknown } }[] = [];

    const api = {
      event: {
        on: (eventName: string, handler: (payload?: unknown) => void) => {
          events.set(eventName, handler);
          return () => events.delete(eventName);
        },
      },
      lifecycle: {
        onDispose: (handler: () => void) => disposers.push(handler),
      },
      slots: {
        register: (registration: { slots: { sidebar_content: (ctx: unknown, slotInput: unknown) => unknown } }) => {
          slotRegistrations.push(registration);
        },
      },
      theme: { current: { text: 'white', textMuted: 'gray' } },
    } as unknown as TuiPluginApi;

    await registerQuotaTui(api, {
      minRefreshIntervalMs: 60_000,
      pollIntervalMs: 0,
      providerCacheTtlMs: 60_000,
      visibleProviders: ['openrouter'],
    });

    await flushAsyncTasks();

    expect(fetchProviderLines).toHaveBeenCalledTimes(1);
    resolvers[0]?.('stale-data');
    await flushAsyncTasks();
    await flushAsyncTasks();

    expect(signals[0]?.get()).toEqual([headingLine('OpenRouter'), detailTextLine('stale-data', 'error')]);

    vi.advanceTimersByTime(60_000);
    events.get('tui.session.select')?.({});
    vi.advanceTimersByTime(300);
    await flushAsyncTasks();

    expect(fetchProviderLines).toHaveBeenCalledTimes(2);
    expect(signals[0]?.get()).toEqual([headingLine('OpenRouter'), detailTextLine('stale-data', 'error')]);

    events.get('session.status')?.({
      properties: {
        state: {
          status: 'completed',
        },
      },
    });

    resolvers[1]?.('ignored-data');
    await flushAsyncTasks();
    await flushAsyncTasks();

    expect(fetchProviderLines).toHaveBeenCalledTimes(2);
    expect(
      (signals[0]?.get() as Array<{ kind: string; text?: string }> | undefined)?.some(
        (line) => line.kind === 'detail' && line.text === 'stale-data',
      ),
    ).toBe(false);
    expect(signals[0]?.get()).toEqual([headingLine('OpenRouter'), detailTextLine('Refreshing…')]);

    vi.advanceTimersByTime(550);
    await flushAsyncTasks();
    await flushAsyncTasks();

    expect(signals[0]?.get()).toEqual([headingLine('OpenRouter'), detailTextLine('Refreshing…')]);

    expect(fetchProviderLines).toHaveBeenCalledTimes(3);

    resolvers[2]?.('fresh-data');
    await flushAsyncTasks();
    await flushAsyncTasks();

    expect(signals[0]?.get()).toEqual([headingLine('OpenRouter'), detailTextLine('fresh-data', 'error')]);

    disposers.forEach((dispose) => dispose());
    vi.doUnmock('../src/domain/provider-results.ts');
    vi.doUnmock('solid-js');
    vi.resetModules();
  });

  it('keeps stale data visible with a refreshing marker when an invalidating event is throttled without an active refresh', async () => {
    vi.resetModules();

    const resolvers: Array<(value: unknown) => void> = [];
    const fetchProviderLines = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const signals: Array<{ get: () => unknown; set: (value: unknown) => void }> = [];

    vi.doMock('solid-js', () => ({
      createSignal: <T>(initial: T) => {
        let value = initial;
        const get = () => value;
        const set = (next: unknown) => {
          value = next as T;
        };

        signals.push({ get, set });
        return [get, set] as const;
      },
      Show: (props: { when: boolean; fallback?: unknown; children?: unknown }) =>
        props.when ? props.children : props.fallback,
    }));
    vi.doMock('../src/domain/provider-results.ts', async () => {
      const actual = await vi.importActual<typeof import('../src/domain/provider-results.ts')>(
        '../src/domain/provider-results.ts',
      );

      return {
        ...actual,
        fetchProviderLines,
      };
    });

    const { registerQuotaTui } = await import('../src/runtime/runtime.tsx');
    const events = new Map<string, (payload?: unknown) => void>();
    const disposers: Array<() => void> = [];
    const slotRegistrations: { slots: { sidebar_content: (ctx: unknown, slotInput: unknown) => unknown } }[] = [];

    const api = {
      event: {
        on: (eventName: string, handler: (payload?: unknown) => void) => {
          events.set(eventName, handler);
          return () => events.delete(eventName);
        },
      },
      lifecycle: {
        onDispose: (handler: () => void) => disposers.push(handler),
      },
      slots: {
        register: (registration: { slots: { sidebar_content: (ctx: unknown, slotInput: unknown) => unknown } }) => {
          slotRegistrations.push(registration);
        },
      },
      theme: { current: { text: 'white', textMuted: 'gray' } },
    } as unknown as TuiPluginApi;

    await registerQuotaTui(api, {
      minRefreshIntervalMs: 1_000,
      pollIntervalMs: 0,
      providerCacheTtlMs: 60_000,
      visibleProviders: ['openrouter'],
    });

    await flushAsyncTasks();

    expect(slotRegistrations).toHaveLength(1);
    expect(fetchProviderLines).toHaveBeenCalledTimes(1);

    resolvers[0]?.([detailTextLine('initial-data')]);
    await flushAsyncTasks();
    await flushAsyncTasks();

    expect(signals[0]?.get()).toEqual([headingLine('OpenRouter'), detailTextLine('initial-data')]);

    vi.advanceTimersByTime(100);
    events.get('session.status')?.({
      properties: {
        state: {
          status: 'completed',
        },
      },
    });

    await flushAsyncTasks();

    expect(signals[0]?.get()).toEqual([headingLine('OpenRouter'), detailTextLine('Refreshing…')]);
    expect(fetchProviderLines).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(300);
    await flushAsyncTasks();

    expect(fetchProviderLines).toHaveBeenCalledTimes(1);
    expect(signals[0]?.get()).toEqual([headingLine('OpenRouter'), detailTextLine('Refreshing…')]);

    vi.advanceTimersByTime(250);
    await flushAsyncTasks();

    expect(fetchProviderLines).toHaveBeenCalledTimes(2);
    expect(signals[0]?.get()).toEqual([headingLine('OpenRouter'), detailTextLine('Refreshing…')]);

    resolvers[1]?.([detailTextLine('fresh-data')]);
    await flushAsyncTasks();
    await flushAsyncTasks();

    expect(signals[0]?.get()).toEqual([headingLine('OpenRouter'), detailTextLine('fresh-data')]);

    disposers.forEach((dispose) => dispose());
    vi.doUnmock('../src/domain/provider-results.ts');
    vi.doUnmock('solid-js');
    vi.resetModules();
  });

  it('prefers the earlier deferred refresh boundary over a later one', () => {
    expect(shouldKeepDeferredRefreshTimer(2_000, 1_500)).toBe(false);
    expect(shouldKeepDeferredRefreshTimer(1_500, 2_000)).toBe(true);
  });

  it('does not clear visible data for non-terminal updates while a refresh is in flight', async () => {
    vi.resetModules();

    const resolvers: Array<(value: unknown) => void> = [];
    const fetchProviderLines = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const signals: Array<{ get: () => unknown; set: (value: unknown) => void }> = [];

    vi.doMock('solid-js', () => ({
      createSignal: <T>(initial: T) => {
        let value = initial;
        const get = () => value;
        const set = (next: unknown) => {
          value = next as T;
        };

        signals.push({ get, set });
        return [get, set] as const;
      },
      Show: (props: { when: boolean; fallback?: unknown; children?: unknown }) =>
        props.when ? props.children : props.fallback,
    }));
    vi.doMock('../src/domain/provider-results.ts', async () => {
      const actual = await vi.importActual<typeof import('../src/domain/provider-results.ts')>(
        '../src/domain/provider-results.ts',
      );

      return {
        ...actual,
        fetchProviderLines,
      };
    });

    const { registerQuotaTui } = await import('../src/runtime/runtime.tsx');
    const events = new Map<string, (payload?: unknown) => void>();
    const disposers: Array<() => void> = [];
    const slotRegistrations: { slots: { sidebar_content: (ctx: unknown, slotInput: unknown) => unknown } }[] = [];

    const api = {
      event: {
        on: (eventName: string, handler: (payload?: unknown) => void) => {
          events.set(eventName, handler);
          return () => events.delete(eventName);
        },
      },
      lifecycle: {
        onDispose: (handler: () => void) => disposers.push(handler),
      },
      slots: {
        register: (registration: { slots: { sidebar_content: (ctx: unknown, slotInput: unknown) => unknown } }) => {
          slotRegistrations.push(registration);
        },
      },
      theme: { current: { text: 'white', textMuted: 'gray' } },
    } as unknown as TuiPluginApi;

    await registerQuotaTui(api, {
      minRefreshIntervalMs: 0,
      pollIntervalMs: 0,
      providerCacheTtlMs: 60_000,
      visibleProviders: ['openrouter'],
    });

    await flushAsyncTasks();

    expect(slotRegistrations).toHaveLength(1);
    expect(fetchProviderLines).toHaveBeenCalledTimes(1);

    resolvers[0]?.([detailTextLine('initial-data')]);
    await flushAsyncTasks();
    await flushAsyncTasks();

    expect(signals[0]?.get()).toEqual([headingLine('OpenRouter'), detailTextLine('initial-data')]);

    events.get('session.status')?.({
      properties: {
        state: {
          status: 'completed',
        },
      },
    });
    vi.advanceTimersByTime(550);
    await flushAsyncTasks();

    expect(fetchProviderLines).toHaveBeenCalledTimes(2);
    expect(signals[0]?.get()).toEqual([headingLine('OpenRouter'), detailTextLine('Refreshing…')]);

    events.get('message.part.updated')?.({
      properties: {
        part: {
          type: 'tool',
          tool: 'task',
          state: {
            status: 'running',
          },
        },
      },
    });

    await flushAsyncTasks();

    expect(signals[0]?.get()).toEqual([headingLine('OpenRouter'), detailTextLine('Refreshing…')]);

    resolvers[1]?.([detailTextLine('fresh-data')]);
    await flushAsyncTasks();
    await flushAsyncTasks();

    expect(signals[0]?.get()).toEqual([headingLine('OpenRouter'), detailTextLine('fresh-data')]);

    disposers.forEach((dispose) => dispose());
    vi.doUnmock('../src/domain/provider-results.ts');
    vi.doUnmock('solid-js');
    vi.resetModules();
  });

  it('starts provider refreshes in parallel and applies each result as it settles', async () => {
    const started: string[] = [];
    const resolvers: Record<string, (value: string) => void> = {};
    const results = new Map([
      ['github-copilot' as const, null],
      ['openrouter' as const, null],
    ]);
    const onUpdate = vi.fn();

    const refreshPromise = refreshQuotaProviders({
      visibleProviders: [
        { id: 'github-copilot', label: 'GitHub Copilot' },
        { id: 'openrouter', label: 'OpenRouter' },
      ],
      results,
      goConfig: null,
      getCachedProviderLines: (providerId) => {
        started.push(providerId);

        return new Promise((resolve) => {
          resolvers[providerId] = resolve;
        });
      },
      shouldContinue: () => true,
      onUpdate,
    });

    expect(started).toEqual(['github-copilot', 'openrouter']);

    resolvers.openrouter?.('openrouter-ready');
    await Promise.resolve();

    expect(results.get('openrouter')).toBe('openrouter-ready');
    expect(results.get('github-copilot')).toBeNull();
    expect(onUpdate).toHaveBeenCalledTimes(1);

    resolvers['github-copilot']?.('copilot-ready');
    await refreshPromise;

    expect(results.get('github-copilot')).toBe('copilot-ready');
    expect(onUpdate).toHaveBeenCalledTimes(2);
  });

  it('recognizes rate-limit errors and ignores plain parse errors', () => {
    expect(isQuotaRateLimitError('Request failed with status code 429: Too Many Requests')).toBe(true);
    expect(isQuotaRateLimitError('Rate limit exceeded while processing request')).toBe(true);
    expect(isQuotaRateLimitError('Cannot parse response: unexpected token in JSON at position 1')).toBe(false);
  });

  it('does not classify generic 403 auth/forbidden errors as rate-limit errors', () => {
    expect(isQuotaRateLimitError('Request failed with status code 403: Forbidden')).toBe(false);
    expect(isQuotaRateLimitError('HTTP 403 Unauthorized')).toBe(false);
    expect(isQuotaRateLimitError('Access denied with status 403')).toBe(false);
  });

  it('classifies 403 as rate-limit only when accompanied by rate-limit keywords', () => {
    expect(isQuotaRateLimitError('HTTP 403 temporarily blocked for abuse')).toBe(true);
    expect(isQuotaRateLimitError('403 secondary rate limit detected')).toBe(true);
    expect(isQuotaRateLimitError('status 403: rate limit exceeded')).toBe(true);
  });

  it('honors retry-after details even when an error body follows', () => {
    expect(retryAfterMsFromMessage('OpenAI HTTP 429; retry-after=3600; body: slow down')).toBe(3_600_000);
    expect(retryAfterMsFromMessage('OpenRouter HTTP 429; retry-after 120: slow down')).toBe(120_000);
  });

  it('normalizes Copilot reset_at values in seconds and milliseconds', () => {
    expect(normalizeCopilotResetAtMs(1_700_000_000)).toBe(1_700_000_000_000);
    expect(normalizeCopilotResetAtMs(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  it('returns a clear timeout error from fetchWithTimeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    });

    const request = fetchWithTimeout('https://example.test/slow', {}, 250);
    vi.advanceTimersByTime(250);

    await expect(request).rejects.toThrow('Request to https://example.test/slow timed out after 250ms');
  });

  it('returns a stable error for malformed OpenRouter credit payloads', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'openrouter-token');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('null', { status: 200 }));

    await expect(fetchOpenRouterQuota()).resolves.toEqual({
      error: 'OpenRouter did not return expected credit data',
    });
  });

  it('sanitizes html and invalid-json responses from provider endpoints', async () => {
    vi.stubEnv(
      'XDG_DATA_HOME',
      createAuthFixture({
        'github-copilot': { type: 'oauth', access: 'copilot-token' },
        openai: { type: 'oauth', access: 'openai-token', account_id: 'acct-123' },
      }),
    );

    const fetchMock = vi.spyOn(globalThis, 'fetch');

    fetchMock.mockResolvedValueOnce(
      new Response(
        '<!doctype html><html><head><title>Quota Failure</title></head><body><h1>\u001b[31mNope\nline</h1></body></html>',
        { status: 200 },
      ),
    );

    const copilot = await fetchCopilotQuota();
    expect(copilot).not.toBeNull();
    expect(copilot && 'error' in copilot).toBe(true);
    if (copilot && 'error' in copilot) {
      expect(copilot.error).toContain('Copilot API returned invalid JSON');
      expect(copilot.error).toContain('HTML response: Quota Failure');
      expect(copilot.error).not.toContain('<html>');
      expect(copilot.error).not.toContain('<title>');
      expect(copilot.error).not.toContain('\u001b');
      expect(copilot.error).not.toContain('\n');
    }

    fetchMock.mockResolvedValueOnce(new Response('\u001b[31mnot json\nline2', { status: 200 }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ available_count: 0, credits: [] }), { status: 200 }));

    const openai = await fetchOpenAIQuota({ experimentalResetCredits: true });
    expect(openai).not.toBeNull();
    expect(openai && 'error' in openai).toBe(true);
    if (openai && 'error' in openai) {
      expect(openai.error).toContain('OpenAI returned invalid JSON');
      expect(openai.error).toContain('not json line2');
      expect(openai.error).not.toContain('\u001b');
      expect(openai.error).not.toContain('\n');
    }
  });

  it('sanitizes html bodies returned by non-ok responses', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'openrouter-token');

    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(
      new Response(
        '<!doctype html><html><head><title>Gateway Down</title></head><body><h1>\u001b[31mTry again\nlater</h1></body></html>',
        {
          status: 502,
          headers: { 'content-type': 'text/html' },
        },
      ),
    );

    const result = await fetchOpenRouterQuota();
    expect(result).not.toBeNull();
    expect(result && 'error' in result).toBe(true);
    if (result && 'error' in result) {
      expect(result.error).toContain('OpenRouter HTTP 502');
      expect(result.error).toContain('HTML response: Gateway Down');
      expect(result.error).not.toContain('<html>');
      expect(result.error).not.toContain('<title>');
      expect(result.error).not.toContain('\u001b');
      expect(result.error).not.toContain('\n');
    }
  });

  it('formats weekly responsible usage pace against elapsed window time', () => {
    expect(
      formatResponsibleWeeklyUsage({
        usedPct: 4,
        resetSec: 6 * 24 * 60 * 60 + 18 * 60 * 60,
      }),
    ).toBe('⚠ 0.43% over');

    expect(
      formatResponsibleWeeklyUsage({
        usedPct: 50,
        resetSec: 4 * 24 * 60 * 60,
      }),
    ).toBe('⚠ 7.14% over');

    expect(
      formatResponsibleWeeklyUsage({
        usedPct: 60,
        resetSec: 4 * 24 * 60 * 60,
      }),
    ).toBe('⚠ 17.14% over');

    expect(
      formatResponsibleWeeklyUsage({
        usedPct: 20,
        resetSec: 6 * 24 * 60 * 60,
      }),
    ).toBe('⚠ 5.71% over');
  });

  it('formats durations including minutes and seconds', () => {
    expect(fmtDuration(6 * 86400 + 23 * 3600 + 12 * 60 + 34)).toBe('6d23h12m');
    expect(fmtDuration(75)).toBe('1m15s');
  });

  it('parses Codex Spark additional rate limit', () => {
    const limits = parseAdditionalRateLimits([
      {
        limit_name: 'GPT-5.3-Codex-Spark',
        metered_feature: '...',
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: {
            used_percent: 12.5,
            reset_after_seconds: 3600,
            reset_at: 1234567890,
            limit_window_seconds: 18000,
          },
          secondary_window: {
            used_percent: 25,
            reset_after_seconds: 7200,
            reset_at: 1234567890,
            limit_window_seconds: 604800,
          },
        },
      },
    ]);

    expect(limits).toHaveLength(1);
    expect(limits[0]).toMatchObject({
      label: 'Codex Spark',
      allowed: true,
      limitReached: false,
      primary: {
        usedPct: 12.5,
        resetSec: 3600,
        limitWindowSec: 18000,
      },
      secondary: {
        usedPct: 25,
        resetSec: 7200,
        limitWindowSec: 604800,
      },
    });
  });

  it('parses a well-formed reset-credits payload with one available credit', () => {
    const nowMs = Date.parse('2026-06-20T12:00:00Z');
    const result = parseResetCreditsPayload(
      {
        available_count: 1,
        credits: [
          {
            granted_at: '2026-06-17T17:38:38Z',
            expires_at: '2026-07-17T17:38:38Z',
            status: 'available',
          },
        ],
      },
      nowMs,
    );

    expect(result.state).toBe('available');
    expect(result.availableCount).toBe(1);
    expect(result.credits).toHaveLength(1);
    expect(result.credits[0]).toEqual({
      grantedAtIso: '2026-06-17T17:38:38Z',
      expiresAtIso: '2026-07-17T17:38:38Z',
      status: 'available',
    });
    expect(result.nextExpiresAtMs).toBe(Date.parse('2026-07-17T17:38:38Z'));
  });

  it('treats a 200 response with zero credits as none-available rather than an error', () => {
    const result = parseResetCreditsPayload({ available_count: 0, credits: [] });

    expect(result.state).toBe('none-available');
    expect(result.availableCount).toBe(0);
    expect(result.credits).toEqual([]);
    expect(result.nextExpiresAtMs).toBeUndefined();
  });

  it('returns unavailable state for a malformed payload', () => {
    const result = parseResetCreditsPayload('not an object');

    expect(result.state).toBe('unavailable');
    expect(result.availableCount).toBe(0);
    expect(result.errorMessage).toBe('Invalid reset-credits payload');
  });

  it('returns unavailable state for a null payload', () => {
    const result = parseResetCreditsPayload(null);

    expect(result.state).toBe('unavailable');
    expect(result.availableCount).toBe(0);
  });

  it('filters out expired credits when computing nextExpiresAtMs', () => {
    const nowMs = Date.parse('2026-06-20T12:00:00Z');
    const result = parseResetCreditsPayload(
      {
        available_count: 2,
        credits: [
          {
            granted_at: '2026-05-01T00:00:00Z',
            expires_at: '2026-06-01T00:00:00Z',
            status: 'expired',
          },
          {
            granted_at: '2026-06-17T17:38:38Z',
            expires_at: '2026-07-17T17:38:38Z',
            status: 'available',
          },
        ],
      },
      nowMs,
    );

    expect(result.state).toBe('available');
    expect(result.availableCount).toBe(2);
    expect(result.nextExpiresAtMs).toBe(Date.parse('2026-07-17T17:38:38Z'));
  });

  it('handles camelCase field names in reset-credits payload', () => {
    const nowMs = Date.parse('2026-06-20T12:00:00Z');
    const result = parseResetCreditsPayload(
      {
        availableCount: 1,
        credits: [
          {
            grantedAt: '2026-06-17T17:38:38Z',
            expiresAt: '2026-07-17T17:38:38Z',
          },
        ],
      },
      nowMs,
    );

    expect(result.state).toBe('available');
    expect(result.availableCount).toBe(1);
    expect(result.credits[0]?.grantedAtIso).toBe('2026-06-17T17:38:38Z');
    expect(result.credits[0]?.expiresAtIso).toBe('2026-07-17T17:38:38Z');
  });

  it('fetches usage and reset credits in parallel and merges the results', async () => {
    vi.stubEnv(
      'XDG_DATA_HOME',
      createAuthFixture({
        openai: { type: 'oauth', access: 'openai-token', account_id: 'acct-123' },
      }),
    );

    const fetchMock = vi.spyOn(globalThis, 'fetch');

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          rate_limit: {
            primary_window: { used_percent: 20, reset_after_seconds: 300 },
            secondary_window: { used_percent: 30, reset_after_seconds: 600 },
          },
          credits: { has_credits: true, balance: 5.0 },
        }),
        { status: 200 },
      ),
    );

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          available_count: 1,
          credits: [
            {
              granted_at: '2026-06-17T17:38:38Z',
              expires_at: '2026-07-17T17:38:38Z',
              status: 'available',
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await fetchOpenAIQuota({ experimentalResetCredits: true });
    expect(result).not.toBeNull();
    expect(result && 'error' in result).toBe(false);

    if (result && !('error' in result)) {
      expect(result.hourly?.usedPct).toBe(20);
      expect(result.weekly?.usedPct).toBe(30);
      expect(result.credits).toBe('$5.00');
      expect(result.resetCredits?.state).toBe('available');
      expect(result.resetCredits?.availableCount).toBe(1);
      expect(result.resetCredits?.credits).toHaveLength(1);
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not break OpenAI usage display when reset-credits fetch fails', async () => {
    vi.stubEnv(
      'XDG_DATA_HOME',
      createAuthFixture({
        openai: { type: 'oauth', access: 'openai-token', account_id: 'acct-123' },
      }),
    );

    const fetchMock = vi.spyOn(globalThis, 'fetch');

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          rate_limit: {
            primary_window: { used_percent: 20, reset_after_seconds: 300 },
            secondary_window: { used_percent: 30, reset_after_seconds: 600 },
          },
        }),
        { status: 200 },
      ),
    );

    fetchMock.mockResolvedValueOnce(new Response('Forbidden', { status: 403 }));

    const result = await fetchOpenAIQuota({ experimentalResetCredits: true });
    expect(result).not.toBeNull();
    expect(result && 'error' in result).toBe(false);

    if (result && !('error' in result)) {
      expect(result.hourly?.usedPct).toBe(20);
      expect(result.weekly?.usedPct).toBe(30);
      expect(result.resetCredits?.state).toBe('unavailable');
      expect(result.resetCredits?.availableCount).toBe(0);
    }
  });

  it('returns error when usage fetch fails even if reset credits would succeed', async () => {
    vi.stubEnv(
      'XDG_DATA_HOME',
      createAuthFixture({
        openai: { type: 'oauth', access: 'openai-token', account_id: 'acct-123' },
      }),
    );

    const fetchMock = vi.spyOn(globalThis, 'fetch');

    fetchMock.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ available_count: 1, credits: [] }), { status: 200 }));

    const result = await fetchOpenAIQuota({ experimentalResetCredits: true });
    expect(result).not.toBeNull();
    expect(result && 'error' in result).toBe(true);
    if (result && 'error' in result) {
      expect(result.error).toContain('OpenAI HTTP 401');
    }
  });

  it('does not fetch reset credits by default and omits resetCredits from the result', async () => {
    vi.stubEnv(
      'XDG_DATA_HOME',
      createAuthFixture({
        openai: { type: 'oauth', access: 'openai-token', account_id: 'acct-123' },
      }),
    );

    const fetchMock = vi.spyOn(globalThis, 'fetch');

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          rate_limit: {
            primary_window: { used_percent: 20, reset_after_seconds: 300 },
            secondary_window: { used_percent: 30, reset_after_seconds: 600 },
          },
        }),
        { status: 200 },
      ),
    );

    const result = await fetchOpenAIQuota();
    expect(result).not.toBeNull();
    expect(result && 'error' in result).toBe(false);

    if (result && !('error' in result)) {
      expect(result.hourly?.usedPct).toBe(20);
      expect(result.weekly?.usedPct).toBe(30);
      expect(result.resetCredits).toBeUndefined();
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not fetch reset credits when experimentalOpenAIResetCredits is explicitly false', async () => {
    vi.stubEnv(
      'XDG_DATA_HOME',
      createAuthFixture({
        openai: { type: 'oauth', access: 'openai-token', account_id: 'acct-123' },
      }),
    );

    const fetchMock = vi.spyOn(globalThis, 'fetch');

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          rate_limit: {
            primary_window: { used_percent: 10, reset_after_seconds: 300 },
            secondary_window: { used_percent: 15, reset_after_seconds: 600 },
          },
        }),
        { status: 200 },
      ),
    );

    const result = await fetchOpenAIQuota({ experimentalResetCredits: false });
    expect(result).not.toBeNull();
    expect(result && 'error' in result).toBe(false);

    if (result && !('error' in result)) {
      expect(result.resetCredits).toBeUndefined();
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resolves experimentalOpenAIResetCredits to true only when explicitly set', () => {
    expect(resolveQuotaPluginOptions({ experimentalOpenAIResetCredits: true }).experimentalOpenAIResetCredits).toBe(
      true,
    );
    expect(resolveQuotaPluginOptions({ experimentalOpenAIResetCredits: false }).experimentalOpenAIResetCredits).toBe(
      false,
    );
    expect(resolveQuotaPluginOptions({ experimentalOpenAIResetCredits: 'yes' }).experimentalOpenAIResetCredits).toBe(
      false,
    );
    expect(resolveQuotaPluginOptions({ experimentalOpenAIResetCredits: 1 }).experimentalOpenAIResetCredits).toBe(false);
    expect(resolveQuotaPluginOptions(undefined).experimentalOpenAIResetCredits).toBe(false);
  });

  it('preserves rate-limit backoff state when invalidating visible data cache', async () => {
    const { createQuotaProviderCache } = await import('../src/infrastructure/cache.ts');
    const fetchProviderLines = vi.fn();

    const { providerCache, getCachedProviderLines, invalidateVisibleData } = createQuotaProviderCache({
      providerCacheTtlMilliseconds: 60_000,
      providerErrorBackoffMilliseconds: 900_000,
      fetchProviderLines,
    });

    fetchProviderLines.mockRejectedValueOnce(new Error('HTTP 429: rate limit'));
    await getCachedProviderLines('openrouter', null);

    const entry = providerCache.get('openrouter');
    expect(entry).toBeDefined();
    expect(entry?.cooldownUntilMilliseconds).toBeDefined();
    expect(entry?.consecutiveErrors).toBe(1);
    const preservedCooldown = entry?.cooldownUntilMilliseconds;
    const preservedErrors = entry?.consecutiveErrors;

    invalidateVisibleData();

    const afterInvalidation = providerCache.get('openrouter');
    expect(afterInvalidation).toBeDefined();
    expect(afterInvalidation?.value).toBeUndefined();
    expect(afterInvalidation?.fetchedAtMilliseconds).toBe(0);
    expect(afterInvalidation?.cooldownUntilMilliseconds).toBe(preservedCooldown);
    expect(afterInvalidation?.consecutiveErrors).toBe(preservedErrors);
  });

  it('clears inFlight promises on invalidation so the next call triggers a fresh fetch', async () => {
    const { createQuotaProviderCache } = await import('../src/infrastructure/cache.ts');
    let fetchCallCount = 0;
    const resolvers: Array<(value: string) => void> = [];
    const fetchProviderLines = vi.fn(() => {
      fetchCallCount++;
      return new Promise<string>((resolve) => {
        resolvers.push(resolve);
      });
    });

    const { providerCache, getCachedProviderLines, invalidateVisibleData } = createQuotaProviderCache({
      providerCacheTtlMilliseconds: 60_000,
      providerErrorBackoffMilliseconds: 900_000,
      fetchProviderLines,
    });

    const firstCall = getCachedProviderLines('openrouter', null);
    expect(fetchCallCount).toBe(1);

    const entry = providerCache.get('openrouter');
    expect(entry?.inFlight).toBeDefined();

    invalidateVisibleData();

    const afterInvalidation = providerCache.get('openrouter');
    expect(afterInvalidation?.inFlight).toBeUndefined();

    const secondCall = getCachedProviderLines('openrouter', null);
    expect(fetchCallCount).toBe(2);

    const secondEntry = providerCache.get('openrouter');
    expect(secondEntry?.inFlight).toBeDefined();
    expect(secondEntry?.inFlight).not.toBe(firstCall);

    resolvers[0]?.('first-data');
    resolvers[1]?.('second-data');
    await Promise.all([firstCall, secondCall]);
  });

  it('does not let a stale pre-invalidation response overwrite newer cached data', async () => {
    const { createQuotaProviderCache } = await import('../src/infrastructure/cache.ts');
    const resolvers: Array<(value: string) => void> = [];
    const fetchProviderLines = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const { providerCache, getCachedProviderLines, invalidateVisibleData } = createQuotaProviderCache({
      providerCacheTtlMilliseconds: 60_000,
      providerErrorBackoffMilliseconds: 900_000,
      fetchProviderLines,
    });

    const firstCall = getCachedProviderLines('openrouter', null);
    invalidateVisibleData();
    const secondCall = getCachedProviderLines('openrouter', null);

    resolvers[1]?.('fresh-data');
    await secondCall;
    expect(providerCache.get('openrouter')?.value).toBe('fresh-data');

    resolvers[0]?.('stale-data');
    await firstCall;
    expect(providerCache.get('openrouter')?.value).toBe('fresh-data');
  });
});
