import type { TuiPluginApi } from '@opencode-ai/plugin/tui';

import { applySubagentEvent } from './events/handling.ts';
import { extractSessionId } from './events/parsing.ts';
import { createCoalescedTaskRunner } from './queue.ts';
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
import type { PersistSnapshotMeta } from './persisted-snapshot.ts';
import { normalizeEventPayload } from './boundaries/event-payload.ts';
import { createSessionClientBoundary } from './boundaries/session-client.ts';
import { pruneTerminalChildren } from '../domain/state.ts';
import { reconcileChildrenState } from '../domain/reconcile.ts';
import type { SubagentState } from '../domain/types.ts';
import { hydrateStateFromRecoverySources } from '../infrastructure/recovery.ts';
import type { RecoverySource } from '../infrastructure/recovery.ts';
import type { ResolvedSubagentStatusPluginOptions } from './options.ts';
import type { createRuntimeSessionScopeHelpers } from './session-scope.ts';

type RuntimeSessionScopeHelpers = ReturnType<typeof createRuntimeSessionScopeHelpers>;

type RuntimeStateAccess = {
  getState: () => SubagentState;
  getSessionId: () => string;
};

type CreatePersistMeta = (source: PersistSnapshotMeta['source']) => PersistSnapshotMeta;

type RefreshRequest = {
  sessionId: string;
  sessionToken: number;
};

export const createTuiRuntimeRefresh = (
  api: TuiPluginApi,
  input: {
    state: RuntimeStateAccess;
    sessionScope: RuntimeSessionScopeHelpers;
    recoverySources: RecoverySource[];
    staleRunningProbePolicy: ResolvedSubagentStatusPluginOptions['staleRunningProbePolicy'];
    staleRunningProbeStateBySessionId: Map<string, StaleRunningProbeState>;
    createPersistMeta: CreatePersistMeta;
    syncState: (nextState: SubagentState, meta: PersistSnapshotMeta) => Promise<void>;
    isDisposed: () => boolean;
  },
) => {
  const sessionClient = createSessionClientBoundary(api);

  const isInactiveSessionToken = (sessionToken: number): boolean =>
    input.isDisposed() || sessionToken !== input.sessionScope.currentSessionToken();

  const mergeEventState = async (event: unknown): Promise<void> => {
    if (input.isDisposed()) return;

    const normalizedEvent = normalizeEventPayload(event);
    if (!normalizedEvent) return;

    const eventSessionId = extractSessionId(normalizedEvent);
    if (input.state.getSessionId() && eventSessionId && eventSessionId !== input.state.getSessionId()) return;
    if (!input.state.getSessionId() && eventSessionId) {
      if (input.sessionScope.isBufferingStartupScopedEvents()) {
        input.sessionScope.bufferStartupScopedEvent(eventSessionId, normalizedEvent);
      }
      return;
    }

    const nextState = structuredClone(input.state.getState());
    const changed = applySubagentEvent(nextState, normalizedEvent);
    if (!changed) return;

    pruneTerminalChildren(nextState);
    await input.syncState(nextState, input.createPersistMeta('event'));
  };

  const refreshRunner = createCoalescedTaskRunner(async (request: RefreshRequest): Promise<void> => {
    const { sessionId, sessionToken } = request;
    if (isInactiveSessionToken(sessionToken)) return;

    try {
      if (!sessionId) return;

      const response = await sessionClient.listChildren(sessionId);
      if (isInactiveSessionToken(sessionToken)) return;

      const directory = api.state.path.directory;
      const { changed, nextState } = reconcileChildrenState(input.state.getState(), response);
      const staleRunningProbeTargets = resolveStaleRunningProbeTargets(
        nextState,
        input.staleRunningProbeStateBySessionId,
        input.staleRunningProbePolicy,
        Date.now(),
      );
      const tuiStatusHydrated = hydrateChildStatusesFromTuiState(api, nextState, staleRunningProbeTargets);
      const clientStatusHydrated = await hydrateChildStatusesFromClient(api, nextState, staleRunningProbeTargets);
      settleStaleRunningProbeTargets(
        nextState,
        input.staleRunningProbeStateBySessionId,
        staleRunningProbeTargets,
        input.staleRunningProbePolicy,
        Date.now(),
      );
      const pruned = pruneTerminalChildren(nextState);
      if (isInactiveSessionToken(sessionToken)) return;
      if (!changed && !tuiStatusHydrated && !clientStatusHydrated && !pruned) {
        return;
      }

      await input.syncState(nextState, input.createPersistMeta('refresh'));
    } catch {
      // Refresh is best-effort.
    }
  });

  const recoveryHydrationRunner = createCoalescedTaskRunner(async (request: RefreshRequest): Promise<void> => {
    const { sessionId, sessionToken } = request;
    if (isInactiveSessionToken(sessionToken)) return;

    try {
      if (!sessionId) return;

      const nextState = structuredClone(input.state.getState());
      const directory = api.state.path.directory;
      const recovered = await hydrateStateFromRecoverySources(
        nextState,
        { directory, parentSessionID: sessionId },
        input.recoverySources,
      );
      if (isInactiveSessionToken(sessionToken)) return;

      const hydrated = await hydrateChildTokensFromLogs(nextState);
      const pruned = pruneTerminalChildren(nextState);
      if (isInactiveSessionToken(sessionToken)) return;
      if (!recovered.changed && !hydrated && !pruned) {
        return;
      }

      await input.syncState(nextState, input.createPersistMeta('refresh'));
    } catch {
      // Recovery hydration is best-effort.
    }
  });

  const refresh = async (
    sessionId = input.state.getSessionId(),
    sessionToken = input.sessionScope.currentSessionToken(),
  ): Promise<void> => {
    await refreshRunner({ sessionId, sessionToken });
    if (isInactiveSessionToken(sessionToken)) return;
    await input.sessionScope.replayDeferredStartupScopedEvents(
      sessionId,
      sessionToken,
      mergeEventState,
      input.isDisposed,
    );
    if (isInactiveSessionToken(sessionToken)) return;

    void recoveryHydrationRunner({ sessionId, sessionToken });
  };

  return {
    mergeEventState,
    refresh,
  };
};
