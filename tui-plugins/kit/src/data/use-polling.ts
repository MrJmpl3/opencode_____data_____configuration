import { onCleanup } from 'solid-js/dist/solid.js';
import type { Accessor } from 'solid-js';

import type { ResourceReturn } from './create-resource.js';

// ── Public types ──────────────────────────────────────────────────────────────

export interface PollingOptions<T> {
  resource: ResourceReturn<T>;
  intervalMs: number;
  active?: Accessor<boolean>;
}

export interface PollingReturn {
  dispose: () => void;
}

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * `usePolling` composable for periodic `createResource` execution, gated by an
 * optional `active` accessor (plugs into `useSlotVisibility`). Cleans up on
 * Solid `onCleanup` or manual `dispose()`.
 */
export const usePolling = <T>(options: PollingOptions<T>): PollingReturn => {
  const { resource, intervalMs, active } = options;

  let disposed = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const tick = (): void => {
    if (disposed) return;
    if (active && !active()) return;
    resource.refetch();
  };

  timer = setInterval(tick, intervalMs);

  const dispose = (): void => {
    disposed = true;
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  onCleanup(dispose);

  return { dispose };
};
