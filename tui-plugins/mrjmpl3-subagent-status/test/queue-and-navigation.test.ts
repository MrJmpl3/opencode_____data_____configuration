import { describe, expect, it, vi } from 'vitest';

import { createBufferedTaskQueue, createCoalescedTaskRunner, createSerializedTaskQueue } from '../src/runtime/queue.ts';
import { resolveSessionSlotTransition } from '../src/runtime/navigation.ts';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

describe('tui runtime helpers', () => {
  it('serializes queued persistence writes', async () => {
    const firstGate = deferred<void>();
    const calls: string[] = [];
    const queue = createSerializedTaskQueue(async (value: string) => {
      calls.push(value);
      if (value === 'first') {
        await firstGate.promise;
      }
    });

    const first = queue('first');
    await Promise.resolve();

    const second = queue('second');
    await Promise.resolve();

    expect(calls).toEqual(['first']);

    firstGate.resolve();
    await first;
    await second;

    expect(calls).toEqual(['first', 'second']);
  });

  it('coalesces refresh requests into one rerun after completion', async () => {
    const firstGate = deferred<void>();
    const calls: string[] = [];
    const refresh = createCoalescedTaskRunner(async (sessionID: string) => {
      calls.push(sessionID);
      if (calls.length === 1) {
        await firstGate.promise;
      }
    });

    const first = refresh('ses_first');
    await Promise.resolve();

    const second = refresh('ses_second');
    const third = refresh('ses_third');
    await Promise.resolve();

    expect(calls).toEqual(['ses_first']);

    firstGate.resolve();
    await first;
    await second;
    await third;

    expect(calls).toEqual(['ses_first', 'ses_third']);
  });

  it('coalesces undefined payloads without treating them as empty state', async () => {
    const calls: Array<undefined> = [];
    const refresh = createCoalescedTaskRunner(async (value: undefined) => {
      calls.push(value);
    });

    await refresh(undefined);

    expect(calls).toEqual([undefined]);
  });

  it('buffers events until the queue is marked ready', async () => {
    const calls: string[] = [];
    const buffered = createBufferedTaskQueue(async (value: string) => {
      calls.push(value);
    });

    buffered.push('early');
    await Promise.resolve();
    expect(calls).toEqual([]);

    await buffered.markReady();
    await Promise.resolve();

    expect(calls).toEqual(['early']);
  });

  it('buffers undefined values until the queue is marked ready', async () => {
    const calls: Array<undefined> = [];
    const buffered = createBufferedTaskQueue(async (value: undefined) => {
      calls.push(value);
    });

    buffered.push(undefined);
    await Promise.resolve();
    expect(calls).toEqual([]);

    await buffered.markReady();
    await Promise.resolve();

    expect(calls).toEqual([undefined]);
  });

  it('caps the startup buffer and keeps the newest events', async () => {
    const calls: string[] = [];
    const buffered = createBufferedTaskQueue(
      async (value: string) => {
        calls.push(value);
      },
      { maxSize: 3, maxAgeMs: 60_000 },
    );

    buffered.push('one');
    buffered.push('two');
    buffered.push('three');
    buffered.push('four');

    expect(buffered.size()).toBe(3);

    await buffered.markReady();
    await Promise.resolve();

    expect(calls).toEqual(['two', 'three', 'four']);
    expect(buffered.wasTruncated()).toBe(true);
  });

  it('collapses a stale startup buffer instead of letting it grow indefinitely', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    try {
      const calls: string[] = [];
      const buffered = createBufferedTaskQueue(
        async (value: string) => {
          calls.push(value);
        },
        { maxSize: 10, maxAgeMs: 1_000 },
      );

      buffered.push('one');
      vi.setSystemTime(1_500);
      buffered.push('two');
      vi.setSystemTime(3_000);
      buffered.push('three');

      expect(buffered.size()).toBe(1);

      await buffered.markReady();
      await Promise.resolve();

      expect(calls).toEqual(['three']);
      expect(buffered.wasTruncated()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops expired buffered events when the queue becomes ready after a long startup delay', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    try {
      const calls: string[] = [];
      const buffered = createBufferedTaskQueue(
        async (value: string) => {
          calls.push(value);
        },
        { maxSize: 10, maxAgeMs: 1_000 },
      );

      buffered.push('stale');
      vi.setSystemTime(5_000);

      await buffered.markReady();
      await Promise.resolve();

      expect(calls).toEqual([]);
      expect(buffered.size()).toBe(0);
      expect(buffered.wasTruncated()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resets state when switching session routes', () => {
    expect(resolveSessionSlotTransition('ses_old', { session_id: 'ses_new' }, true)).toEqual({
      nextSessionID: 'ses_new',
      resetState: true,
      shouldRefresh: true,
    });
  });

  it('clears state when leaving a session route', () => {
    expect(resolveSessionSlotTransition('ses_old', {}, true)).toEqual({
      nextSessionID: '',
      resetState: true,
      shouldRefresh: false,
    });
  });
});
