import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as quotaIndex from '../index.tsx';
import plugin, { formatResponsibleWeeklyUsage, isQuotaRateLimitError, retryAfterMsFromMessage } from '../index.tsx';
import { createRefreshScheduler } from '../runtime/refresh-scheduler.ts';
import { refreshQuotaProviders } from '../runtime/runtime.tsx';
import * as quotaProviders from '../providers.ts';
import {
  fetchCopilotQuota,
  fetchWithTimeout,
  fetchOpenAIQuota,
  fetchOpenRouterQuota,
  fmtDuration,
  normalizeCopilotResetAtMs,
  parseAdditionalRateLimits,
} from '../providers.ts';

const createAuthFixture = (entries: Record<string, unknown>): string => {
  const root = mkdtempSync(join(tmpdir(), 'opencode-quota-'));
  const authDir = join(root, 'opencode');
  mkdirSync(authDir, { recursive: true });
  writeFileSync(join(authDir, 'auth.json'), JSON.stringify(entries), 'utf8');
  return root;
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

  it('keeps the current providers export surface available', () => {
    expect(typeof quotaProviders.fetchCopilotQuota).toBe('function');
    expect(typeof quotaProviders.fetchOpenAIQuota).toBe('function');
    expect(typeof quotaProviders.fetchOpenRouterQuota).toBe('function');
    expect(typeof quotaProviders.fmtDuration).toBe('function');
    expect(typeof quotaProviders.parseAdditionalRateLimits).toBe('function');
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

  it('formats weekly responsible usage pace with accumulated daily budget', () => {
    expect(
      formatResponsibleWeeklyUsage({
        usedPct: 4,
        resetSec: 6 * 24 * 60 * 60 + 18 * 60 * 60,
      }),
    ).toBe('✓ ok · 10.29% below');

    expect(
      formatResponsibleWeeklyUsage({
        usedPct: 50,
        resetSec: 4 * 24 * 60 * 60,
      }),
    ).toBe('✓ ok · 7.14% below');

    expect(
      formatResponsibleWeeklyUsage({
        usedPct: 60,
        resetSec: 4 * 24 * 60 * 60,
      }),
    ).toBe('⚠ high · 2.86% over');

    expect(
      formatResponsibleWeeklyUsage({
        usedPct: 20,
        resetSec: 6 * 24 * 60 * 60,
      }),
    ).toBe('✓ ok · 8.57% below');
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
