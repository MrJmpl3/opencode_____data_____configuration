export interface RefreshSchedulerConfig {
  subscribe: (eventName: string, handler: () => void) => () => void;
  onRefresh: (source?: string) => void;
  immediateEvents: string[];
  completionEvents: string[];
}

export interface RefreshScheduler {
  scheduleRefresh(extraDelays?: number[], source?: string): void;
  dispose(): void;
}

export function createRefreshScheduler({
  subscribe,
  onRefresh,
  immediateEvents,
  completionEvents,
}: RefreshSchedulerConfig): RefreshScheduler {
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  const REFRESH_DELAYS_MS = [150, 600];
  let disposed = false;

  function scheduleRefresh(extraDelays: number[] = [], source?: string) {
    for (const delay of [...REFRESH_DELAYS_MS, ...extraDelays]) {
      const timer = setTimeout(() => {
        if (disposed) return;
        pendingTimers.delete(timer);
        onRefresh(source);
      }, delay);
      pendingTimers.add(timer);
    }
  }

  function bindEvents(eventNames: string[], extraDelays: number[] = []) {
    return eventNames.map((eventName) =>
      subscribe(eventName, () => scheduleRefresh(extraDelays, eventName)),
    );
  }

  const unsubscribers = [
    ...bindEvents(immediateEvents),
    ...bindEvents(completionEvents, [250]),
  ];

  function dispose() {
    disposed = true;
    for (const unsub of unsubscribers) unsub();
    for (const timer of pendingTimers) clearTimeout(timer);
    pendingTimers.clear();
  }

  return {
    scheduleRefresh,
    dispose,
  };
}
