import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchWithTimeout } from '../src/infrastructure/providers/http.js';

describe('fetchWithTimeout (AbortSignal plumbing)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes merged signal to fetch when caller signal is provided', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const callerController = new AbortController();

    await fetchWithTimeout(
      'https://example.com/api',
      {},
      10000,
      callerController.signal,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const passedSignal = (fetchSpy.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(passedSignal.signal).toBeInstanceOf(AbortSignal);
    expect(passedSignal.signal!.aborted).toBe(false);

    vi.unstubAllGlobals();
  });

  it('aborts via timeout and throws with timeout message', async () => {
    // Simulate a real fetch that respects the AbortSignal — rejects on abort.
    const fetchSpy = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
          return;
        }
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const promise = fetchWithTimeout('https://example.com/api', {}, 100);

    // Advance past timeout — should trigger AbortController abort.
    vi.advanceTimersByTime(100);

    await expect(promise).rejects.toThrow(/timed out/);

    vi.unstubAllGlobals();
  });

  it('aborts via caller signal when merged via AbortSignal.any()', async () => {
    const fetchSpy = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
          return;
        }
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const callerController = new AbortController();

    const promise = fetchWithTimeout(
      'https://example.com/api',
      {},
      60000, // Long timeout so only caller signal matters.
      callerController.signal,
    );

    // Abort before timeout via caller.
    callerController.abort();

    await expect(promise).rejects.toThrow();

    vi.unstubAllGlobals();
  });
});
