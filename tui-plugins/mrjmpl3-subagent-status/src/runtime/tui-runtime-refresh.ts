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
import { isTerminalStatus, pruneTerminalChildren } from '../domain/state.ts';
import { normalizeChildrenResponse, reconcileNormalizedChildrenState } from '../domain/reconcile.ts';
import type { SubagentChild, SubagentState } from '../domain/types.ts';
import { hydrateStateFromRecoverySources } from '../infrastructure/recovery.ts';
import type { RecoveryResult, RecoverySource } from '../infrastructure/recovery.ts';
import type { ResolvedSubagentStatusPluginOptions } from './options.ts';
import type { createRuntimeSessionScopeHelpers } from './session-scope.ts';
import { isRealSessionRow, resolveSessionRowSessionId } from './session-row.ts';

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

const createEmptyRecoveryResult = (): RecoveryResult => ({
  changed: false,
  authoritativeSessionIDs: [],
});

const resolveTerminalRecoverySessionIDs = (
  state: SubagentState,
  authoritativeSessionIDs: ReadonlySet<string>,
): Set<string> => {
  const terminalSessionIDs = new Set<string>();

  for (const child of Object.values(state.children)) {
    if (!isRealSessionRow(child) || !isTerminalStatus(child.status)) continue;

    const sessionId = resolveSessionRowSessionId(child);
    if (sessionId && authoritativeSessionIDs.has(sessionId)) {
      terminalSessionIDs.add(sessionId);
    }
  }

  return terminalSessionIDs;
};

const hydrateRecoverySourcesSafely = async (input: {
  state: SubagentState;
  directory: string;
  parentSessionID: string;
  recoverySources: RecoverySource[];
}): Promise<RecoveryResult> => {
  try {
    return await hydrateStateFromRecoverySources(
      input.state,
      { directory: input.directory, parentSessionID: input.parentSessionID },
      input.recoverySources,
    );
  } catch {
    return createEmptyRecoveryResult();
  }
};

const resolveClientSnapshotSessionIDs = (children: readonly SubagentChild[]): string[] => {
  return children
    .filter((child) => isRealSessionRow(child))
    .map((child) => resolveSessionRowSessionId(child))
    .filter((candidate): candidate is string => Boolean(candidate));
};

const mergeAuthoritativeSessionIDs = (
  recoverySessionIDs: ReadonlySet<string>,
  children: readonly SubagentChild[],
): Set<string> => {
  const authoritativeSessionIDs = new Set(recoverySessionIDs);

  for (const childSessionID of resolveClientSnapshotSessionIDs(children)) {
    authoritativeSessionIDs.add(childSessionID);
  }

  return authoritativeSessionIDs;
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

      let nextState = structuredClone(input.state.getState());
      const directory = api.state.path.directory;
      const recovered = await hydrateRecoverySourcesSafely({
        state: nextState,
        directory,
        parentSessionID: sessionId,
        recoverySources: input.recoverySources,
      });
      if (isInactiveSessionToken(sessionToken)) return;

      const recoverySessionIDs = new Set(recovered.authoritativeSessionIDs);
      const protectedRecoverySessionIDs = new Set(
        recovered.protectedTerminalSessionIDs ?? recovered.authoritativeSessionIDs,
      );
      const terminalRecoverySessionIDs = resolveTerminalRecoverySessionIDs(nextState, protectedRecoverySessionIDs);
      let response: unknown;
      try {
        response = await sessionClient.listChildren(sessionId);
      } catch {
        if (recovered.changed) {
          await input.syncState(nextState, input.createPersistMeta('refresh'));
        }
        return;
      }
      if (isInactiveSessionToken(sessionToken)) return;

      const incomingChildren = normalizeChildrenResponse(response);
      const authoritativeSessionIDs = mergeAuthoritativeSessionIDs(recoverySessionIDs, incomingChildren);
      const { changed, nextState: reconciledState } = reconcileNormalizedChildrenState(nextState, incomingChildren, {
        recoverySessionIDs,
        terminalRecoverySessionIDs,
      });
      nextState = reconciledState;

      const staleRunningProbeTargets = resolveStaleRunningProbeTargets(
        nextState,
        input.staleRunningProbeStateBySessionId,
        input.staleRunningProbePolicy,
        Date.now(),
      );
      const runningEvidenceSessionIDs = new Set<string>();
      const tuiStatusHydrated = hydrateChildStatusesFromTuiState(
        api,
        nextState,
        staleRunningProbeTargets,
        runningEvidenceSessionIDs,
        { terminalRecoverySessionIDs },
      );
      const clientStatusHydrated = await hydrateChildStatusesFromClient(
        api,
        nextState,
        staleRunningProbeTargets,
        runningEvidenceSessionIDs,
        { terminalRecoverySessionIDs },
      );
      const staleRunningSettled = settleStaleRunningProbeTargets(
        nextState,
        input.staleRunningProbeStateBySessionId,
        staleRunningProbeTargets,
        authoritativeSessionIDs,
        runningEvidenceSessionIDs,
        input.staleRunningProbePolicy,
        Date.now(),
      );
      const pruned = pruneTerminalChildren(nextState);
      if (isInactiveSessionToken(sessionToken)) return;
      if (
        !recovered.changed &&
        !changed &&
        !tuiStatusHydrated &&
        !clientStatusHydrated &&
        !staleRunningSettled &&
        !pruned
      ) {
        return;
      }

      await input.syncState(nextState, input.createPersistMeta('refresh'));
    } catch {
      // Refresh is best-effort.
    }
  });

  const tokenBackfillRunner = createCoalescedTaskRunner(async (request: RefreshRequest): Promise<void> => {
    const { sessionId, sessionToken } = request;
    if (isInactiveSessionToken(sessionToken)) return;

    try {
      if (!sessionId) return;

      const nextState = structuredClone(input.state.getState());
      const hydrated = await hydrateChildTokensFromLogs(nextState);
      const pruned = pruneTerminalChildren(nextState);
      if (isInactiveSessionToken(sessionToken)) return;
      if (!hydrated && !pruned) {
        return;
      }

      await input.syncState(nextState, input.createPersistMeta('refresh'));
    } catch {
      // Token backfill is best-effort.
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

    void tokenBackfillRunner({ sessionId, sessionToken });
  };

  return {
    mergeEventState,
    refresh,
  };
};
