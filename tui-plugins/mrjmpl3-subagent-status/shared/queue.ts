export function createSerializedTaskQueue<T>(task: (value: T) => Promise<void>): (value: T) => Promise<void> {
  const queue: T[] = [];
  let active = false;

  const drain = async (): Promise<void> => {
    if (active) return;
    active = true;

    try {
      while (queue.length > 0) {
        const next = queue.shift();
        if (next === undefined) continue;
        await task(next);
      }
    } finally {
      active = false;
    }
  };

  return (value: T): Promise<void> => {
    queue.push(value);
    return drain();
  };
}

export function createCoalescedTaskRunner<T>(task: (value: T) => Promise<void>): (value: T) => Promise<void> {
  let inFlight = false;
  let hasPending = false;
  let pendingValue: T;
  let currentBatch: Promise<void> | undefined;

  const schedule = async (value: T): Promise<void> => {
    pendingValue = value;
    hasPending = true;
    if (inFlight) return currentBatch ?? Promise.resolve();

    inFlight = true;
    currentBatch = (async () => {
      try {
        while (hasPending) {
          const current = pendingValue;
          hasPending = false;
          await task(current);
        }
      } finally {
        inFlight = false;
        if (hasPending) {
          const next = pendingValue;
          hasPending = false;
          await schedule(next);
        }
        currentBatch = undefined;
      }
    })();

    return currentBatch;
  };

  return schedule;
}

type BufferedTaskQueueOptions = {
  maxSize?: number;
  maxAgeMs?: number;
};

export function createBufferedTaskQueue<T>(task: (value: T) => Promise<void>, options: BufferedTaskQueueOptions = {}) {
  const maxSize = options.maxSize ?? 512;
  const maxAgeMs = options.maxAgeMs ?? 15_000;
  const queue: Array<{ value: T; enqueuedAt: number }> = [];
  let ready = false;
  let draining = false;
  let truncated = false;

  const compactIfStale = (now: number): void => {
    if (queue.length === 0) return;
    if (now - queue[0].enqueuedAt < maxAgeMs) return;

    queue.length = 0;
    truncated = true;
  };

  const drain = async (): Promise<void> => {
    if (!ready || draining) return;

    draining = true;
    try {
      while (queue.length > 0) {
        const entry = queue.shift();
        if (!entry) continue;

        await task(entry.value);
      }
    } finally {
      draining = false;
    }
  };

  return {
    push(value: T): void {
      const now = Date.now();
      compactIfStale(now);
      queue.push({ value, enqueuedAt: now });

      if (queue.length > maxSize) {
        queue.splice(0, queue.length - maxSize);
        truncated = true;
      }

      if (ready) void drain();
    },
    size(): number {
      return queue.length;
    },
    wasTruncated(): boolean {
      return truncated;
    },
    markReady(): Promise<void> {
      ready = true;
      return drain();
    },
  };
}
