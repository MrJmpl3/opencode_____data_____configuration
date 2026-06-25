import { createSignal, onCleanup } from 'solid-js/dist/solid.js';
import type { Accessor } from 'solid-js';

// ── Public types ──────────────────────────────────────────────────────────────

export interface ResourceOptions<T> {
  fetcher: (signal: AbortSignal) => Promise<T>;
  ttl: number;
  retry?: number;
  backoff?: { base: number; max: number };
}

export interface ResourceReturn<T> {
  data: Accessor<T | undefined>;
  loading: Accessor<boolean>;
  error: Accessor<unknown>;
  refetch: () => void;
  dispose: () => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Exponential backoff: base * 2^attempt, capped at max. */
const backoffDelay = (attempt: number, base: number, max: number): number =>
  Math.min(base * 2 ** attempt, max);

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * Declarative `createResource` composable wrapping fetch with TTL cache,
 * retry/backoff, and reactive abort tied to Solid ownership.
 *
 * Replacement for quota's `cache.ts` and subagent-status's inline fetch.
 */
export const createResource = <T>(options: ResourceOptions<T>): ResourceReturn<T> => {
  const { fetcher, ttl, retry = 0, backoff = { base: 1000, max: 30000 } } = options;

  const [data, setData] = createSignal<T | undefined>(undefined);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<unknown>(undefined);

  let cachedAtMs = 0;
  let currentController: AbortController | undefined;
  let disposed = false;

  const abortInFlight = () => {
    if (currentController) {
      currentController.abort();
      currentController = undefined;
    }
  };

  const executeFetch = async (signal: AbortSignal): Promise<T> => {
    let lastError: unknown;

    for (let attempt = 0; attempt <= retry; attempt++) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

      try {
        const result = await fetcher(signal);
        return result;
      } catch (err: unknown) {
        lastError = err;
        // On AbortError, stop retrying immediately.
        if (err instanceof DOMException && err.name === 'AbortError') throw err;

        if (attempt < retry) {
          // Wait with exponential backoff before next attempt.
          const delay = backoffDelay(attempt, backoff.base, backoff.max);
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, delay);
            const onAbort = () => {
              clearTimeout(timer);
              reject(new DOMException('Aborted', 'AbortError'));
            };
            signal.addEventListener('abort', onAbort, { once: true });
          });
        }
      }
    }

    throw lastError;
  };

  const fetchAndCache = async () => {
    abortInFlight();

    const controller = new AbortController();
    currentController = controller;

    setLoading(true);
    setError(undefined);

    try {
      const result: T = await executeFetch(controller.signal);
      if (!disposed && currentController === controller) {
        setData(() => result);
        cachedAtMs = Date.now();
      }
    } catch (err: unknown) {
      if (!disposed && currentController === controller) {
        // On abort, don't overwrite error — it's an intentional disposal.
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          setError(err);
        }
      }
    } finally {
      if (currentController === controller) {
        currentController = undefined;
        setLoading(false);
      }
    }
  };

  // ── data accessor with TTL check ────────────────────────────────────────────

  const readData = (): T | undefined => {
    const now = Date.now();
    if (cachedAtMs > 0 && now - cachedAtMs < ttl) {
      return data();
    }

    // TTL expired or never fetched — trigger fetch.
    void fetchAndCache();
    return data();
  };

  // ── Public API ──────────────────────────────────────────────────────────────

  const refetch = (): void => {
    if (disposed) return;
    // Bypass TTL by calling fetchAndCache directly — do NOT reset cachedAtMs
    // so that a failed refetch still retains the previous TTL window.
    void fetchAndCache();
  };

  const dispose = (): void => {
    disposed = true;
    abortInFlight();
    setLoading(false);
  };

  // Kick off initial fetch.
  void fetchAndCache();

  // Register Solid cleanup.
  onCleanup(() => {
    disposed = true;
    abortInFlight();
    setLoading(false);
  });

  return {
    data: readData,
    loading,
    error,
    refetch,
    dispose,
  };
};
