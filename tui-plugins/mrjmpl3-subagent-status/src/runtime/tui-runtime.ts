import type { TuiPluginApi } from '@opencode-ai/plugin/tui';

import { installEventBridge } from './events/bridge.ts';
import { createBufferedTaskQueue } from './queue.ts';
import { normalizeSubagentStatusPluginOptions, type ResolvedSubagentStatusPluginOptions } from './options.ts';
import { resolveSessionSlotTransition } from './navigation.ts';
import { createRuntimeSessionScopeHelpers } from './session-scope.ts';
import { createEmptyState } from '../domain/state.ts';
import type { SubagentState } from '../domain/types.ts';
import {
  createPersistQueue,
  loadState,
  resolveStatePath,
  resolveTextPath,
  shouldPreserveStateOnStartup,
} from '../infrastructure/persistence.ts';
import { createRecoverySources } from '../infrastructure/recovery-sources.ts';
import { formatPersistedSnapshot, type PersistSnapshotMeta } from './persisted-snapshot.ts';
import { createTuiRuntimeRefresh } from './tui-runtime-refresh.ts';
import { isRecord } from '../shared/coercion.ts';

export type TuiRuntime = {
  bootstrap: () => Promise<void>;
  refreshFromSlot: (slotInput: unknown) => void;
  dispose: () => void;
};

export const createTuiRuntime = (
  api: TuiPluginApi,
  input: {
    getState: () => SubagentState;
    setState: (state: SubagentState) => void;
    getSessionId: () => string;
    setSessionId: (sessionId: string) => void;
    setNowMs: (nowMs: number) => void;
  },
  options: ResolvedSubagentStatusPluginOptions = normalizeSubagentStatusPluginOptions(undefined),
): TuiRuntime => {
  const statePath = resolveStatePath({
    workspaceDirectory: api.state.path.directory,
    statePath: options.persistence.statePath,
  });
  const textPath = resolveTextPath(statePath);
  const persistQueuedSnapshot = createPersistQueue(statePath, textPath, formatPersistedSnapshot);
  const recoverySources = createRecoverySources({ sqliteDatabasePath: options.recovery.sqliteDatabasePath });
  const staleRunningProbePolicy = options.staleRunningProbePolicy;
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

  const sessionScope = createRuntimeSessionScopeHelpers({
    getSessionId: input.getSessionId,
    setSessionId: input.setSessionId,
    syncState,
    createRefreshMeta: () => createPersistMeta('refresh'),
  });

  const { mergeEventState, refresh } = createTuiRuntimeRefresh(api, {
    state: {
      getState: input.getState,
      getSessionId: input.getSessionId,
    },
    sessionScope,
    recoverySources,
    staleRunningProbePolicy,
    staleRunningProbeStateBySessionId: new Map(),
    createPersistMeta,
    syncState,
    isDisposed: () => disposed,
  });

  const refreshFromSlot = (slotInput: unknown): void => {
    const transition = resolveSessionSlotTransition(
      input.getSessionId(),
      slotInput,
      Object.keys(input.getState().children).length > 0,
    );

    if (!transition.nextSessionId) {
      if (transition.resetState) {
        sessionScope.resetSessionScope();
      }
      return;
    }

    if (transition.resetState) {
      sessionScope.beginSessionScope(transition.nextSessionId);
      void refresh(transition.nextSessionId);
      return;
    }

    if (transition.shouldRefresh) {
      void refresh(transition.nextSessionId);
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

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;

    if (tickTimer) clearInterval(tickTimer);
    if (reconcileTimer) clearInterval(reconcileTimer);
  };

  return {
    bootstrap,
    refreshFromSlot,
    dispose,
  };
};
