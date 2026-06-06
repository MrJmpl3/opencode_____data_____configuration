import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { TuiPluginApi, TuiPluginMeta } from '@opencode-ai/plugin/tui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as quotaIndex from '../index.tsx';
import plugin, { formatResponsibleWeeklyUsage, isQuotaRateLimitError, retryAfterMsFromMessage } from '../index.tsx';
import { createRefreshScheduler } from '../src/runtime/refresh-scheduler.ts';
import { refreshQuotaProviders } from '../src/runtime/runtime.tsx';
import { fetchCopilotQuota, normalizeCopilotResetAtMs } from '../src/infrastructure/providers/copilot.ts';
import { fmtDuration } from '../src/infrastructure/providers/format.ts';
import { fetchWithTimeout } from '../src/infrastructure/providers/http.ts';
import { fetchOpenAIQuota, parseAdditionalRateLimits } from '../src/infrastructure/providers/openai.ts';
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
    expect(typeof quotaIndex.retryAfterMsFromMessage).toBe('function');
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
    const events = new Map<string, () => void>();
    const disposers: (() => void)[] = [];
    const slotRegistrations: { slots: { sidebar_content: (ctx: unknown, slotInput: unknown) => unknown } }[] = [];

    const api = {
      event: {
        on: (eventName: string, handler: () => void) => {
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
    expect(events.has('tui.session.select')).toBe(true);
    expect(events.has('session.idle')).toBe(true);

    disposers.forEach((dispose) => dispose());
    await vi.runAllTimersAsync();
    expect(events.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('coalesces repeated immediate refresh events before execution', () => {
    const events = new Map<string, () => void>();
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

  it('starts provider refreshes in parallel and applies each result as it settles', async () => {
    const started: string[] = [];
    const resolvers: Record<string, (value: string) => void> = {};
    const results = new Map([
      ['copilot' as const, null],
      ['openrouter' as const, null],
    ]);
    const onUpdate = vi.fn();

    const refreshPromise = refreshQuotaProviders({
      visibleProviders: [
        { id: 'copilot', label: 'GitHub Copilot' },
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

    expect(started).toEqual(['copilot', 'openrouter']);

    resolvers.openrouter?.('openrouter-ready');
    await Promise.resolve();

    expect(results.get('openrouter')).toBe('openrouter-ready');
    expect(results.get('copilot')).toBeNull();
    expect(onUpdate).toHaveBeenCalledTimes(1);

    resolvers.copilot?.('copilot-ready');
    await refreshPromise;

    expect(results.get('copilot')).toBe('copilot-ready');
    expect(onUpdate).toHaveBeenCalledTimes(2);
  });

  it('recognizes rate-limit errors and ignores plain parse errors', () => {
    expect(isQuotaRateLimitError('Request failed with status code 429: Too Many Requests')).toBe(true);
    expect(isQuotaRateLimitError('Rate limit exceeded while processing request')).toBe(true);
    expect(isQuotaRateLimitError('Cannot parse response: unexpected token in JSON at position 1')).toBe(false);
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

    const openai = await fetchOpenAIQuota();
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
    ).toBe('⚠ high · 0.43% over');

    expect(
      formatResponsibleWeeklyUsage({
        usedPct: 50,
        resetSec: 4 * 24 * 60 * 60,
      }),
    ).toBe('⚠ high · 7.14% over');

    expect(
      formatResponsibleWeeklyUsage({
        usedPct: 60,
        resetSec: 4 * 24 * 60 * 60,
      }),
    ).toBe('⚠ high · 17.14% over');

    expect(
      formatResponsibleWeeklyUsage({
        usedPct: 20,
        resetSec: 6 * 24 * 60 * 60,
      }),
    ).toBe('⚠ high · 5.71% over');
  });

  it('formats durations including minutes and seconds', () => {
    expect(fmtDuration(6 * 86400 + 23 * 3600 + 12 * 60 + 34)).toBe('6d 23h 12m 34s');
    expect(fmtDuration(75)).toBe('1m 15s');
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
});
