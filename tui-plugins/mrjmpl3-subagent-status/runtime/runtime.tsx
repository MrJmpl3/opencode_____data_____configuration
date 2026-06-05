/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from '@opencode-ai/plugin/tui';
import { createMemo, createRoot, createSignal } from 'solid-js';

import { applySubagentEvent, extractSessionID, installEventBridge } from '../sources/events.ts';
import { hydrateDoneChildTokens } from '../sources/logs.ts';
import { reconcileChildrenState } from '../sources/reconcile.ts';
import { hydrateStateFromRecoverySources } from '../sources/recovery.ts';
import { createSQLiteRecoverySource } from '../sources/recovery/sqlite.ts';
import { createBufferedTaskQueue, createCoalescedTaskRunner } from '../shared/queue.ts';
import { createEmptyState, mergeChildDetails, pruneTerminalChildren } from '../state/state.ts';
import type { SubagentChild, SubagentState } from '../state/types.ts';
import {
  createPersistQueue,
  loadState,
  resolveStatePath,
  resolveTextPath,
  shouldPreserveStateOnStartup,
} from '../storage/persistence.ts';
import type { PersistSnapshotMeta } from '../storage/persistence.ts';
import { resolveNavigationSessionID, resolveSessionSlotTransition } from './navigation.ts';
import { buildTuiSnapshot } from './snapshot.ts';
import { HomeBottomView, SidebarView } from './view.tsx';

type SessionClient = {
  status?: (input: { directory: string }) => Promise<{ data?: Record<string, unknown> } | undefined>;
  messages?: (input: { sessionID: string; directory: string }) => Promise<{ data?: unknown[] } | undefined>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function timestampFromUnknown(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const millis = value < 10_000_000_000 ? value * 1000 : value;
    const parsed = new Date(millis);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
  }

  return undefined;
}

function messageInfo(message: unknown): Record<string, unknown> | undefined {
  const record = isRecord(message) ? message : undefined;
  return isRecord(record?.info) ? record.info : record;
}

function isTerminalStatus(status: SubagentChild['status']): boolean {
  return status === 'done' || status === 'error';
}

function messageActivityAt(message: unknown): string | undefined {
  const info = messageInfo(message);
  const time = isRecord(info?.time) ? info.time : undefined;

  return (
    timestampFromUnknown(time?.completed) ?? timestampFromUnknown(time?.updated) ?? timestampFromUnknown(time?.created)
  );
}

function latestSessionActivityAt(api: TuiPluginApi, sessionID: string): string | undefined {
  try {
    let latestMs = 0;
    for (const message of api.state.session.messages(sessionID)) {
      const timestamp = messageActivityAt(message);
      if (!timestamp) continue;
      latestMs = Math.max(latestMs, Date.parse(timestamp));
    }

    return latestMs > 0 ? new Date(latestMs).toISOString() : undefined;
  } catch {
    return undefined;
  }
}

function completedSessionActivityAt(api: TuiPluginApi, sessionID: string): string | undefined {
  try {
    let latestMs = 0;
    for (const message of api.state.session.messages(sessionID)) {
      const info = messageInfo(message);
      const time = isRecord(info?.time) ? info.time : undefined;
      const completedAt = timestampFromUnknown(time?.completed);
      if (!completedAt) continue;
      latestMs = Math.max(latestMs, Date.parse(completedAt));
    }

    return latestMs > 0 ? new Date(latestMs).toISOString() : undefined;
  } catch {
    return undefined;
  }
}

function deriveClientSessionStatus(value: unknown): SubagentChild['status'] | undefined {
  const source = isRecord(value) ? (value.type ?? value.status ?? value.state) : value;
  if (typeof source !== 'string') return undefined;

  const status = source.trim().toLowerCase();
  if (status === 'busy' || status === 'retry' || status === 'running' || status === 'pending') return 'running';
  if (status === 'done' || status === 'completed' || status === 'complete' || status === 'success') return 'done';
  if (
    status === 'error' ||
    status === 'failed' ||
    status === 'failure' ||
    status === 'cancelled' ||
    status === 'canceled'
  )
    return 'error';

  return undefined;
}

function summarizeMessages(messages: unknown[]): { status?: 'done' | 'error'; endedAt?: string } {
  let completedAtMs = 0;
  let errorAtMs = 0;

  for (const message of messages) {
    const info = messageInfo(message);
    const time = isRecord(info?.time) ? info.time : undefined;
    const completedAt = timestampFromUnknown(time?.completed);
    const updatedAt = timestampFromUnknown(time?.updated) ?? timestampFromUnknown(time?.created);

    if (completedAt) completedAtMs = Math.max(completedAtMs, Date.parse(completedAt));
    if (info?.error && updatedAt) errorAtMs = Math.max(errorAtMs, Date.parse(updatedAt));
  }

  if (errorAtMs > completedAtMs) return { status: 'error', endedAt: new Date(errorAtMs).toISOString() };
  if (completedAtMs > 0) return { status: 'done', endedAt: new Date(completedAtMs).toISOString() };

  return {};
}

function sessionIDForChild(child: SubagentChild): string | undefined {
  return resolveNavigationSessionID(child);
}

async function hydrateChildStatusesFromClient(api: TuiPluginApi, state: SubagentState): Promise<boolean> {
  const sessionClient = api.client.session as unknown as SessionClient | undefined;
  if (!sessionClient) return false;

  const directory = api.state.path.directory;
  let statusBySessionID: Record<string, unknown> = {};

  try {
    statusBySessionID = (await sessionClient.status?.({ directory }))?.data ?? {};
  } catch {
    statusBySessionID = {};
  }

  let changed = false;

  await Promise.all(
    Object.values(state.children).map(async (child) => {
      const sessionID = sessionIDForChild(child);
      if (!sessionID) return;

      const clientStatus = deriveClientSessionStatus(statusBySessionID[sessionID]);
      let messageSummary: { status?: 'done' | 'error'; endedAt?: string } = {};

      try {
        const messages = (await sessionClient.messages?.({ sessionID, directory }))?.data ?? [];
        messageSummary = summarizeMessages(messages);
      } catch {
        messageSummary = {};
      }

      const nextStatus = messageSummary.status ?? clientStatus;
      if (!nextStatus) return;

      if (nextStatus === 'running' && isTerminalStatus(child.status)) {
        return;
      }

      if (nextStatus === 'running') {
        if (child.status !== 'running' || child.endedAt !== undefined) {
          child.status = 'running';
          child.endedAt = undefined;
          child.updatedAt = latestSessionActivityAt(api, sessionID) ?? child.updatedAt;
          changed = true;
        }

        return;
      }

      const endedAt =
        messageSummary.endedAt ?? latestSessionActivityAt(api, sessionID) ?? child.endedAt ?? child.updatedAt;
      if (child.status !== nextStatus || child.endedAt !== endedAt || child.updatedAt !== endedAt) {
        child.status = nextStatus;
        child.endedAt = endedAt;
        child.updatedAt = endedAt;
        changed = true;
      }
    }),
  );

  if (changed) state.updatedAt = new Date().toISOString();

  return changed;
}

function hydrateChildStatusesFromTuiState(api: TuiPluginApi, state: SubagentState): boolean {
  let changed = false;

  for (const child of Object.values(state.children)) {
    const sessionID = child.targetSessionID ?? child.id;
    if (!sessionID || !sessionID.startsWith('ses_')) continue;

    const completedAt = completedSessionActivityAt(api, sessionID);
    const latestActivityAt = latestSessionActivityAt(api, sessionID);
    const rawStatus = api.state.session.status(sessionID)?.type;
    const status = typeof rawStatus === 'string' ? rawStatus.trim().toLowerCase() : undefined;

    if (status === 'busy' || status === 'retry') {
      if (isTerminalStatus(child.status)) {
        continue;
      }

      if (child.status !== 'running' || child.endedAt !== undefined) {
        child.status = 'running';
        child.endedAt = undefined;
        child.updatedAt = latestActivityAt ?? child.updatedAt;
        changed = true;
      }
      continue;
    }

    if (status === 'done' || status === 'completed' || status === 'complete' || status === 'success' || completedAt) {
      const endedAt = completedAt ?? latestActivityAt ?? child.endedAt ?? child.updatedAt;
      if (child.status !== 'done' || child.endedAt !== endedAt) {
        child.status = 'done';
        child.endedAt = endedAt;
        child.updatedAt = endedAt;
        changed = true;
      }
    }
  }

  if (changed) state.updatedAt = new Date().toISOString();

  return changed;
}

export function hydrateChildTokensFromLogs(state: SubagentState): boolean {
  let changed = false;

  for (const child of Object.values(state.children)) {
    if (child.status !== 'done') continue;
    if (child.tokens?.total !== undefined || child.tokens?.input !== undefined || child.tokens?.output !== undefined)
      continue;

    const sessionID = resolveNavigationSessionID(child);
    if (!sessionID) continue;

    const tokens = hydrateDoneChildTokens(sessionID);
    if (!tokens) continue;

    changed = mergeChildDetails(state, child.id, { tokens }) || changed;
  }

  return changed;
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
): TuiRuntime {
  const statePath = resolveStatePath(api.state.path.directory);
  const textPath = resolveTextPath(statePath);
  const persistQueuedSnapshot = createPersistQueue(statePath, textPath);
  const recoverySources = [createSQLiteRecoverySource()];
  const bufferedEvents = createBufferedTaskQueue(async (event: unknown) => {
    await mergeEventState(event);
  });

  let disposed = false;
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let reconcileTimer: ReturnType<typeof setInterval> | undefined;
  let lastEventType: string | undefined;
  let activeSessionToken = 0;
  let bufferingStartupScopedEvents = true;
  const deferredStartupScopedEvents = new Map<string, unknown[]>();

  const invalidateSessionScope = (): number => {
    activeSessionToken += 1;
    return activeSessionToken;
  };

  const resetSessionScope = (): void => {
    invalidateSessionScope();
    input.setSessionId('');
    input.setState(createEmptyState());
  };

  const beginSessionScope = (sid: string): number => {
    const token = invalidateSessionScope();
    input.setSessionId(sid);
    input.setState(createEmptyState());
    return token;
  };

  const syncState = async (nextState: SubagentState, meta: PersistSnapshotMeta): Promise<void> => {
    if (disposed) return;
    input.setState(nextState);
    await persistQueuedSnapshot(nextState, meta);
  };

  const bufferStartupScopedEvent = (sessionID: string, event: unknown): void => {
    const events = deferredStartupScopedEvents.get(sessionID);
    if (events) {
      events.push(event);
      return;
    }

    deferredStartupScopedEvents.set(sessionID, [event]);
  };

  const replayDeferredStartupScopedEvents = async (sessionID: string, sessionToken: number): Promise<void> => {
    if (!sessionID) return;

    const events = deferredStartupScopedEvents.get(sessionID);
    if (!events || events.length === 0) return;

    deferredStartupScopedEvents.delete(sessionID);

    for (const event of events) {
      if (disposed || sessionToken !== activeSessionToken || input.getSessionId() !== sessionID) return;
      await mergeEventState(event);
    }
  };

  const mergeEventState = async (event: unknown): Promise<void> => {
    if (disposed) return;

    const eventSessionID = extractSessionID(event as Parameters<typeof extractSessionID>[0]);
    if (input.getSessionId() && eventSessionID && eventSessionID !== input.getSessionId()) return;
    if (!input.getSessionId() && eventSessionID) {
      if (bufferingStartupScopedEvents) {
        bufferStartupScopedEvent(eventSessionID, event);
      }
      return;
    }

    const nextState = structuredClone(input.getState()) as SubagentState;
    const changed = applySubagentEvent(nextState, event);
    if (!changed) return;

    pruneTerminalChildren(nextState);
    await syncState(nextState, { source: 'event', lastEventType, bufferedEventCount: bufferedEvents.size() });
  };

  const refreshRunner = createCoalescedTaskRunner(
    async (request: { sessionID: string; sessionToken: number }): Promise<void> => {
      const { sessionID: sid, sessionToken } = request;
      if (disposed || sessionToken !== activeSessionToken) return;

      try {
        if (!sid) {
          if (sessionToken !== activeSessionToken) return;
          const emptyState = createEmptyState();
          await syncState(emptyState, { source: 'startup', bufferedEventCount: bufferedEvents.size() });
          return;
        }

        const directory = api.state.path.directory;
        const response = await api.client.session?.children?.({ sessionID: sid, directory });
        if (disposed || sessionToken !== activeSessionToken) return;

        const { changed, nextState } = reconcileChildrenState(input.getState(), response);
        const recovered = await hydrateStateFromRecoverySources(
          nextState,
          { directory, parentSessionID: sid },
          recoverySources,
        );
        const tuiStatusHydrated = hydrateChildStatusesFromTuiState(api, nextState);
        const clientStatusHydrated = await hydrateChildStatusesFromClient(api, nextState);
        const hydrated = hydrateChildTokensFromLogs(nextState);
        const pruned = pruneTerminalChildren(nextState);
        if (disposed || sessionToken !== activeSessionToken) return;
        if (!changed && !recovered.changed && !tuiStatusHydrated && !clientStatusHydrated && !hydrated && !pruned)
          return;

        await syncState(nextState, { source: 'refresh', lastEventType, bufferedEventCount: bufferedEvents.size() });
      } catch {
        // Refresh is best-effort.
      }
    },
  );

  const refresh = (sid = input.getSessionId(), sessionToken = activeSessionToken): Promise<void> =>
    refreshRunner({ sessionID: sid, sessionToken }).then(async () => {
      if (disposed || sessionToken !== activeSessionToken) return;
      await replayDeferredStartupScopedEvents(sid, sessionToken);
    });

  const refreshFromSlot = (slotInput: unknown): void => {
    const transition = resolveSessionSlotTransition(
      input.getSessionId(),
      slotInput,
      Object.keys(input.getState().children).length > 0,
    );

    if (!transition.nextSessionID) {
      if (transition.resetState) {
        resetSessionScope();
      }
      return;
    }

    if (transition.resetState) {
      beginSessionScope(transition.nextSessionID);
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
  }, 60_000);

  const bootstrap = async (): Promise<void> => {
    try {
      if (!shouldPreserveStateOnStartup()) {
        await syncState(createEmptyState(), { source: 'startup', bufferedEventCount: bufferedEvents.size() });
      } else {
        await syncState(await loadState(statePath), { source: 'load', bufferedEventCount: bufferedEvents.size() });
      }

      await refresh(input.getSessionId());
    } finally {
      await bufferedEvents.markReady();
      bufferingStartupScopedEvents = false;
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

export const registerSubagentStatusTui = async (api: TuiPluginApi): Promise<void> => {
  createRoot((disposeRoot) => {
    const { slots } = api;
    const [state, setState] = createSignal<SubagentState>(createEmptyState());
    const [sessionId, setSessionId] = createSignal('');
    const [expanded, setExpanded] = createSignal(true);
    const [nowMs, setNowMs] = createSignal(Date.now());
    const snapshot = createMemo(() => buildTuiSnapshot(state(), nowMs()));
    const runtime = createTuiRuntime(api, {
      getState: state,
      setState,
      getSessionId: sessionId,
      setSessionId,
      setNowMs,
    });

    api.lifecycle.onDispose(() => {
      runtime.dispose();
      disposeRoot();
    });

    slots.register({
      order: 120,
      slots: {
        sidebar_content: (_ctx: unknown, slotInput: unknown) => {
          runtime.refreshFromSlot(slotInput);

          return (
            <SidebarView
              api={api}
              snapshot={snapshot}
              totalExecuted={() => state().totalExecuted}
              expanded={expanded()}
              onToggle={() => setExpanded((value) => !value)}
            />
          );
        },
        home_bottom: () => <HomeBottomView api={api} snapshot={snapshot} totalExecuted={() => state().totalExecuted} />,
      },
    });

    void runtime.bootstrap();
  });
};
