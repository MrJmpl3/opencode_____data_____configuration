import type { TuiPluginApi } from '@opencode-ai/plugin/tui';

import { applySubagentEvent, extractSessionID, installEventBridge } from './events.ts';
import { createBufferedTaskQueue, createCoalescedTaskRunner } from './queue.ts';
import {
  normalizeSubagentStatusPluginOptions,
  type ResolvedSubagentStatusPluginOptions,
} from './options.ts';
import { resolveSessionSlotTransition } from './navigation.ts';
import { createRuntimeSessionScopeHelpers } from './session-scope.ts';
import {
  hydrateChildStatusesFromClient,
  hydrateChildStatusesFromTuiState,
  hydrateChildTokensFromLogs,
} from './status-hydration.ts';
import {
  resolveStaleRunningProbeTargets,
  settleStaleRunningProbeTargets,
  type StaleRunningProbeState,
} from './stale-probe.ts';
import { createEmptyState, pruneTerminalChildren } from '../domain/state.ts';
import { reconcileChildrenState } from '../domain/reconcile.ts';
import type { SubagentState } from '../domain/types.ts';
import { createPersistQueue, loadState, resolveStatePath, resolveTextPath, shouldPreserveStateOnStartup } from '../infrastructure/persistence.ts';
import { hydrateStateFromRecoverySources } from '../infrastructure/recovery.ts';
import { createRecoverySources } from '../infrastructure/recovery-sources.ts';
import { formatPersistedSnapshot, type PersistSnapshotMeta } from './persisted-snapshot.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export type TuiRuntime = {
  bootstrap: () => Promise<void>;
  refreshFromSlot: (slotInput: unknown) => void;
  dispose: () => void;
};

export function createTuiRuntime(
  api: TuiPluginApi,
  input: {
    getState: () => SubagentState;
    setState: (state: SubagentState) => void;
    getSessionId: () => string;
    setSessionId: (sessionID: string) => void;
    setNowMs: (nowMs: number) => void;
  },
  options: ResolvedSubagentStatusPluginOptions = normalizeSubagentStatusPluginOptions(undefined),
): TuiRuntime {
  const statePath = resolveStatePath({
    workspaceDirectory: api.state.path.directory,
    statePath: options.persistence.statePath,
  });
  const textPath = resolveTextPath(statePath);
  const persistQueuedSnapshot = createPersistQueue(statePath, textPath, formatPersistedSnapshot);
  const recoverySources = createRecoverySources({ sqliteDatabasePath: options.recovery.sqliteDatabasePath });
  const staleRunningProbePolicy = options.staleRunningProbePolicy;
  const staleRunningProbeStateBySessionID = new Map<string, StaleRunningProbeState>();
  const bufferedEvents = createBufferedTaskQueue(async (event: unknown) => {
    await mergeEventState(event);
  });

  let disposed = false;
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let reconcileTimer: ReturnType<typeof setInterval> | undefined;
  let lastEventType: string | undefined;

  const createPersistMeta = (source: PersistSnapshotMeta['source']): PersistSnapshotMeta => ({
    source,
    lastEventType,
    bufferedEventCount: bufferedEvents.size(),
  });

  const syncState = async (nextState: SubagentState, meta: PersistSnapshotMeta): Promise<void> => {
    if (disposed) return;
    input.setState(nextState);
    await persistQueuedSnapshot(nextState, meta);
  };

  const isInactiveSessionToken = (sessionToken: number): boolean =>
    disposed || sessionToken !== sessionScope.currentSessionToken();

  const sessionScope = createRuntimeSessionScopeHelpers({
    getSessionId: input.getSessionId,
    setSessionId: input.setSessionId,
    syncState,
    createRefreshMeta: () => createPersistMeta('refresh'),
  });

  const mergeEventState = async (event: unknown): Promise<void> => {
    if (disposed) return;

    const eventSessionID = extractSessionID(event as Parameters<typeof extractSessionID>[0]);
    if (input.getSessionId() && eventSessionID && eventSessionID !== input.getSessionId()) return;
    if (!input.getSessionId() && eventSessionID) {
      if (sessionScope.isBufferingStartupScopedEvents()) {
        sessionScope.bufferStartupScopedEvent(eventSessionID, event);
      }
      return;
    }

    const nextState = structuredClone(input.getState()) as SubagentState;
    const changed = applySubagentEvent(nextState, event);
    if (!changed) return;

    pruneTerminalChildren(nextState);
    await syncState(nextState, createPersistMeta('event'));
  };

  const refreshRunner = createCoalescedTaskRunner(
    async (request: { sessionID: string; sessionToken: number }): Promise<void> => {
      const { sessionID, sessionToken } = request;
      if (isInactiveSessionToken(sessionToken)) return;

      try {
        if (!sessionID) {
          if (isInactiveSessionToken(sessionToken)) return;
          const emptyState = createEmptyState();
          await syncState(emptyState, createPersistMeta('startup'));
          return;
        }

        const directory = api.state.path.directory;
        const response = await api.client.session?.children?.({ sessionID, directory });
        if (isInactiveSessionToken(sessionToken)) return;

        const { changed, nextState } = reconcileChildrenState(input.getState(), response);
        const recovered = await hydrateStateFromRecoverySources(
          nextState,
          { directory, parentSessionID: sessionID },
          recoverySources,
        );
        const staleRunningProbeTargets = resolveStaleRunningProbeTargets(
          nextState,
          staleRunningProbeStateBySessionID,
          staleRunningProbePolicy,
          Date.now(),
        );
        const tuiStatusHydrated = hydrateChildStatusesFromTuiState(api, nextState, staleRunningProbeTargets);
        const clientStatusHydrated = await hydrateChildStatusesFromClient(api, nextState, staleRunningProbeTargets);
        settleStaleRunningProbeTargets(
          nextState,
          staleRunningProbeStateBySessionID,
          staleRunningProbeTargets,
          staleRunningProbePolicy,
          Date.now(),
        );
        const hydrated = hydrateChildTokensFromLogs(nextState);
        const pruned = pruneTerminalChildren(nextState);
        if (isInactiveSessionToken(sessionToken)) return;
        if (!changed && !recovered.changed && !tuiStatusHydrated && !clientStatusHydrated && !hydrated && !pruned) {
          return;
        }

        await syncState(nextState, createPersistMeta('refresh'));
      } catch {
        // Refresh is best-effort.
      }
    },
  );

  const refresh = (sid = input.getSessionId(), sessionToken = sessionScope.currentSessionToken()): Promise<void> =>
    refreshRunner({ sessionID: sid, sessionToken }).then(async () => {
      if (isInactiveSessionToken(sessionToken)) return;
      await sessionScope.replayDeferredStartupScopedEvents(sid, sessionToken, mergeEventState, () => disposed);
    });

  const refreshFromSlot = (slotInput: unknown): void => {
    const transition = resolveSessionSlotTransition(
      input.getSessionId(),
      slotInput,
      Object.keys(input.getState().children).length > 0,
    );

    if (!transition.nextSessionID) {
      if (transition.resetState) {
        sessionScope.resetSessionScope();
      }
      return;
    }

    if (transition.resetState) {
      sessionScope.beginSessionScope(transition.nextSessionID);
      void refresh(transition.nextSessionID);
      return;
    }

    if (transition.shouldRefresh) {
      void refresh(transition.nextSessionID);
    }
  };

  installEventBridge(api, refresh, (event) => {
    lastEventType = isRecord(event) && typeof event.type === 'string' ? event.type : undefined;
    bufferedEvents.push(event);
  });

  tickTimer = setInterval(() => {
    if (!disposed) input.setNowMs(Date.now());
  }, 1000);

  reconcileTimer = setInterval(() => {
    if (!disposed && input.getSessionId()) {
      void refresh();
    }
  }, staleRunningProbePolicy.refreshIntervalMs);

  const bootstrap = async (): Promise<void> => {
    try {
      if (!shouldPreserveStateOnStartup({ preserveStateOnStartup: options.persistence.preserveStateOnStartup })) {
        await syncState(createEmptyState(), createPersistMeta('startup'));
      } else {
        await syncState(await loadState(statePath), createPersistMeta('load'));
      }

      await refresh(input.getSessionId());
    } finally {
      await bufferedEvents.markReady();
      sessionScope.finishStartupScopedEventBuffering();
      if (bufferedEvents.wasTruncated()) {
        void refresh();
      }
    }
  };

  function dispose(): void {
    if (disposed) return;
    disposed = true;

    if (tickTimer) clearInterval(tickTimer);
    if (reconcileTimer) clearInterval(reconcileTimer);
  }

  return {
    bootstrap,
    refreshFromSlot,
    dispose,
  };
}
