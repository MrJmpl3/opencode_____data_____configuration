import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createResource } from '../../src/data/create-resource.js';
import type { ResourceOptions, ResourceReturn } from '../../src/data/create-resource.js';

// Helper: flush microtasks after fake timer advance.
const flushMicrotasks = (): Promise<unknown> => vi.advanceTimersByTimeAsync(0);

describe('createResource', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- TTL scenarios ---

  it('returns cached data while TTL has not expired, without calling fetcher again', async () => {
    const fetcher = vi.fn(async (_signal: AbortSignal) => 42);

    const resource = createResource<number>({
      fetcher: fetcher as (signal: AbortSignal) => Promise<number>,
      ttl: 5000,
    });

    // Initial fetch — fetcher must be called.
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(resource.loading()).toBe(true);

    // Resolve initial fetch.
    await flushMicrotasks();
    expect(resource.data()).toBe(42);
    expect(resource.loading()).toBe(false);
    expect(resource.error()).toBeUndefined();

    // Advance 2s — still within TTL.
    vi.advanceTimersByTime(2000);

    // Reading data() again must NOT call fetcher again.
    const cachedData = resource.data();
    expect(cachedData).toBe(42);
    expect(fetcher).toHaveBeenCalledTimes(1);

    resource.dispose();
  });

  it('triggers refetch when TTL expires', async () => {
    const fetcher = vi.fn(async (_signal: AbortSignal) => 1);

    const resource = createResource<number>({
      fetcher: fetcher as (signal: AbortSignal) => Promise<number>,
      ttl: 3000,
    });

    // Initial fetch.
    await flushMicrotasks();
    expect(resource.data()).toBe(1);
    fetcher.mockClear();

    // Advance beyond TTL.
    vi.advanceTimersByTime(3500);

    // Reading data() after TTL must trigger a new fetch.
    const data = resource.data();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(resource.loading()).toBe(true);

    resource.dispose();
  });

  // --- Retry scenarios ---

  it('retries with exponential backoff and succeeds on second attempt', async () => {
    let calls = 0;
    const fetcher = vi.fn(async (_signal: AbortSignal) => {
      calls += 1;
      if (calls === 1) throw new Error('network error');
      return 99;
    });

    const resource = createResource<number>({
      fetcher: fetcher as (signal: AbortSignal) => Promise<number>,
      ttl: 0,
      retry: 1,
      backoff: { base: 1000, max: 30000 },
    });

    // Initial fetch fails — fetcher called once, retry pending.
    await flushMicrotasks();
    expect(fetcher).toHaveBeenCalledTimes(1);
    // Error not set while retries remain.
    expect(resource.error()).toBeUndefined();

    // Advance past base delay (1s) for retry.
    await vi.advanceTimersByTimeAsync(1000);
    // Flush any remaining microtasks.
    await flushMicrotasks();

    expect(fetcher).toHaveBeenCalledTimes(2);
    // Check loading BEFORE reading data — with ttl:0, data() triggers a new fetch.
    expect(resource.loading()).toBe(false);
    expect(resource.error()).toBeUndefined();
    expect(resource.data()).toBe(99);

    resource.dispose();
  });

  it('reports last error when all retries exhausted, retains last good data', async () => {
    let calls = 0;
    const lastError = new Error('exhausted');
    const fetcher = vi.fn(async (_signal: AbortSignal) => {
      calls += 1;
      if (calls === 1) throw new Error('first fail');
      if (calls === 2) throw new Error('second fail');
      throw lastError;
    });

    const resource = createResource<number>({
      fetcher: fetcher as (signal: AbortSignal) => Promise<number>,
      ttl: 0,
      retry: 2,
      backoff: { base: 500, max: 30000 },
    });

    // Initial fetch fails.
    await flushMicrotasks();
    expect(fetcher).toHaveBeenCalledTimes(1);

    // First retry (500ms backoff).
    await vi.advanceTimersByTimeAsync(500);
    await flushMicrotasks();
    expect(fetcher).toHaveBeenCalledTimes(2);

    // Second retry (1000ms backoff).
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();
    expect(fetcher).toHaveBeenCalledTimes(3);

    // All retries exhausted.
    expect(resource.error()).toBe(lastError);
    expect(resource.loading()).toBe(false);

    resource.dispose();
  });

  // --- Abort on dispose ---

  it('aborts in-flight fetch when disposer is called', async () => {
    const fetcher = vi.fn(async (signal: AbortSignal) => {
      return new Promise<number>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        setTimeout(() => resolve(10), 2000);
      });
    });

    const resource = createResource<number>({
      fetcher: fetcher as (signal: AbortSignal) => Promise<number>,
      ttl: 0,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(resource.loading()).toBe(true);

    // Dispose before the 2s fetch resolves.
    resource.dispose();

    // After dispose, loading must be false.
    await flushMicrotasks();
    expect(resource.loading()).toBe(false);

    // After the fetch would have resolved, data should remain undefined.
    await vi.advanceTimersByTimeAsync(2500);
    expect(resource.data()).toBeUndefined();

    resource.dispose();
  });

  // --- Manual refetch ---

  it('refetch() bypasses TTL and executes fetcher immediately', async () => {
    const fetcher = vi.fn(async (_signal: AbortSignal) => 7);

    const resource = createResource<number>({
      fetcher: fetcher as (signal: AbortSignal) => Promise<number>,
      ttl: 60000,
    });

    // Initial fetch.
    await flushMicrotasks();
    expect(resource.data()).toBe(7);
    fetcher.mockClear();

    // refetch() must call fetcher immediately, ignoring TTL.
    resource.refetch();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(resource.loading()).toBe(true);

    resource.dispose();
  });

  // --- data retains last successful value after error ---

  it('retains the last successful data value when a subsequent fetch fails', async () => {
    let calls = 0;
    const fetcher = vi.fn(async (_signal: AbortSignal) => {
      calls += 1;
      if (calls === 1) return 55;
      throw new Error('fail');
    });

    const resource = createResource<number>({
      fetcher: fetcher as (signal: AbortSignal) => Promise<number>,
      ttl: 5000,
      retry: 0,
    });

    // First fetch succeeds.
    await flushMicrotasks();
    expect(resource.data()).toBe(55);

    // Force refetch that fails.
    resource.refetch();
    await flushMicrotasks();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(resource.error()).toBeInstanceOf(Error);

    // data() must return the last successful value (55), without triggering another fetch.
    expect(resource.data()).toBe(55);

    resource.dispose();
  });
});
