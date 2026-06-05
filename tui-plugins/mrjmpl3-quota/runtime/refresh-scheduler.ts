export interface RefreshSchedulerConfig {
  subscribe: (eventName: string, handler: () => void) => () => void;
  onRefresh: (source?: string) => void;
  immediateEvents: string[];
  completionEvents: string[];
  pollIntervalMs?: number;
  refreshDelayMs?: number;
}

// --- event-driven refresh scheduler ---
// Replaces polling with subscribe-based event binding.
// Events trigger a coalesced timer that calls onRefresh.
// Clean dispose ensures no stale callbacks after unmount.

const DEFAULT_REFRESH_DELAY_MS = 300;
const DEFAULT_POLL_INTERVAL_MS = 10 * 60_000;

export interface RefreshScheduler {
  scheduleRefresh(extraDelays?: number[], source?: string): void;
  dispose(): void;
}

export const createRefreshScheduler = ({
  subscribe,
  onRefresh,
  immediateEvents,
  completionEvents,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  refreshDelayMs = DEFAULT_REFRESH_DELAY_MS,
}: RefreshSchedulerConfig): RefreshScheduler => {
  let disposed = false;
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingDueAtMs = 0;
  let pendingSource: string | undefined;

  // --- polling fallback: infrequent refresh to catch stale data ---
  const pollTimer =
    pollIntervalMs > 0
      ? setInterval(() => {
          if (disposed) return;
          onRefresh('poll');
        }, pollIntervalMs)
      : undefined;

  const scheduleRefresh = (extraDelays: number[] = [], source?: string) => {
    if (disposed) return;

    const delay = refreshDelayMs + (extraDelays[0] ?? 0);
    const dueAtMs = Date.now() + delay;

    if (pendingTimer && pendingDueAtMs <= dueAtMs) {
      return;
    }

    pendingSource = source ?? pendingSource;
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingDueAtMs = dueAtMs;
    pendingTimer = setTimeout(() => {
      if (disposed) return;
      const refreshSource = pendingSource;
      pendingTimer = undefined;
      pendingDueAtMs = 0;
      pendingSource = undefined;
      onRefresh(refreshSource);
    }, delay);
  };

  // --- bindEvents maps event names to refresh triggers ---
  // completionEvents get +250ms extra delay so the LLM finishes settling
  // before fetching updated quota. Prevents reading stale intermediate state.

  const bindEvents = (eventNames: string[], extraDelays: number[] = []) => {
    return eventNames.map((eventName) => subscribe(eventName, () => scheduleRefresh(extraDelays, eventName)));
  };

  const unsubscribers = [...bindEvents(immediateEvents), ...bindEvents(completionEvents, [250])];

  // --- disposed flag prevents onRefresh after unmount ---
  // unsubscribers tear down event bindings, and pendingTimer clears any
  // coalesced refresh that has not fired yet. Triple-lock cleanup.

  const dispose = () => {
    disposed = true;
    if (pollTimer) clearInterval(pollTimer);
    for (const unsub of unsubscribers) unsub();
    if (pendingTimer) clearTimeout(pendingTimer);
  };

  return {
    scheduleRefresh,
    dispose,
  };
};
