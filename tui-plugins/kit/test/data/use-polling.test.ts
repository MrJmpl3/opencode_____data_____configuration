import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createResource } from '../../src/data/create-resource.js';
import { usePolling } from '../../src/data/use-polling.js';

describe('usePolling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls resource.refetch() at the configured interval', () => {
    const fetcher = vi.fn(async (_signal: AbortSignal) => 1);
    const resource = createResource<number>({
      fetcher: fetcher as (signal: AbortSignal) => Promise<number>,
      ttl: 60000,
    });

    // Clear initial fetch call.
    fetcher.mockClear();

    const intervalMs = 600000; // 10 minutes
    usePolling({ resource, intervalMs });

    // Advance 10 minutes.
    vi.advanceTimersByTime(intervalMs);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Advance another 10 minutes.
    vi.advanceTimersByTime(intervalMs);
    expect(fetcher).toHaveBeenCalledTimes(2);

    resource.dispose();
  });

  it('skips refetch when active() returns false', () => {
    const fetcher = vi.fn(async (_signal: AbortSignal) => 1);
    const resource = createResource<number>({
      fetcher: fetcher as (signal: AbortSignal) => Promise<number>,
      ttl: 60000,
    });

    fetcher.mockClear();

    const active = vi.fn(() => false);
    const intervalMs = 10000;

    usePolling({ resource, intervalMs, active });

    vi.advanceTimersByTime(intervalMs);
    expect(fetcher).toHaveBeenCalledTimes(0);

    // Interval still running, another tick.
    vi.advanceTimersByTime(intervalMs);
    expect(fetcher).toHaveBeenCalledTimes(0);

    resource.dispose();
  });

  it('clears interval and disposes resource on dispose()', () => {
    const fetcher = vi.fn(async (_signal: AbortSignal) => 1);
    const resource = createResource<number>({
      fetcher: fetcher as (signal: AbortSignal) => Promise<number>,
      ttl: 60000,
    });

    fetcher.mockClear();

    const intervalMs = 10000;
    const polling = usePolling({ resource, intervalMs });

    // One cycle runs.
    vi.advanceTimersByTime(intervalMs);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Dispose.
    polling.dispose();

    // Advance well beyond interval — no more calls.
    vi.advanceTimersByTime(intervalMs * 3);
    expect(fetcher).toHaveBeenCalledTimes(1);

    resource.dispose();
  });
});
