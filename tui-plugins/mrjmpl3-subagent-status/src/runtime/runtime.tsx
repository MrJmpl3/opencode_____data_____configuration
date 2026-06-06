/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi, TuiPromptRef, TuiSlotContext } from '@opencode-ai/plugin/tui';
import { createEffect, createMemo, createRoot, createSignal } from 'solid-js';

import { applySubagentEvent, extractSessionID, installEventBridge } from './events.ts';
import { registerSubagentCommands } from './commands.ts';
import { focusPromptWithDeferredRetry, resolveSidebarReturnFocusAction } from './focus.ts';
import { deriveSessionStatus } from '../domain/session-status.ts';
import { hydrateDoneChildTokens } from '../infrastructure/logs.ts';
import { reconcileChildrenState } from '../domain/reconcile.ts';
import { hydrateStateFromRecoverySources } from '../infrastructure/recovery.ts';
import { createSQLiteRecoverySource } from '../infrastructure/recovery/sqlite.ts';
import {
  normalizeSubagentStatusPluginOptions,
  type ResolvedSubagentStatusPluginOptions,
  type StaleRunningProbePolicy,
} from './options.ts';
import { createBufferedTaskQueue, createCoalescedTaskRunner } from './queue.ts';
import { createEmptyState, mergeChildDetails, pruneTerminalChildren } from '../domain/state.ts';
import type { SubagentChild, SubagentState } from '../domain/types.ts';
import {
  createPersistQueue,
  loadState,
  resolveStatePath,
  resolveTextPath,
  shouldPreserveStateOnStartup,
} from '../infrastructure/persistence.ts';
import type { PersistSnapshotMeta } from '../infrastructure/persistence.ts';
import { resolveNavigationSessionID, resolveSessionSlotTransition } from './navigation.ts';
import { buildTuiSnapshot } from './snapshot.ts';
import { HomeBottomView, SidebarView } from '../ui/view.tsx';

type SessionClient = {
  status?: (input: { directory: string }) => Promise<{ data?: Record<string, unknown> } | undefined>;
  messages?: (input: { sessionID: string; directory: string }) => Promise<{ data?: unknown[] } | undefined>;
};

type StaleRunningProbeState = {
  attempts: number;
  lastSeenUpdatedAt: string;
  nextProbeAtMs: number;
};

type PromptRefProp = ((ref: TuiPromptRef | undefined) => void) | { current?: TuiPromptRef | undefined } | undefined;

type HomePromptProps = {
  workspaceID?: string;
  workspace_id?: string;
  ref?: PromptRefProp;
  [key: string]: unknown;
};

type SessionPromptProps = {
  sessionID?: string;
  session_id?: string;
  right?: unknown;
  visible?: boolean;
  disabled?: boolean;
  onSubmit?: () => void;
  on_submit?: () => void;
  ref?: PromptRefProp;
  [key: string]: unknown;
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

function isRealSessionRow(child: SubagentChild): boolean {
  return child.source === 'session' || child.id.startsWith('ses_');
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

function nextStaleRunningBackoffMs(attempts: number, policy: StaleRunningProbePolicy): number {
  return Math.min(policy.baseBackoffMs * 2 ** Math.max(0, attempts - 1), policy.maxBackoffMs);
}

function resolveStaleRunningProbeTargets(
  state: SubagentState,
  probeStateBySessionID: Map<string, StaleRunningProbeState>,
  policy: StaleRunningProbePolicy,
  nowMs: number,
): string[] {
  const activeRunningSessionIDs = new Set<string>();
  const targetSessionIDs: string[] = [];

  for (const child of Object.values(state.children)) {
    if (!isRealSessionRow(child) || child.status !== 'running') continue;

    const sessionID = sessionIDForChild(child);
    if (!sessionID) continue;

    activeRunningSessionIDs.add(sessionID);
    const existing = probeStateBySessionID.get(sessionID);

    if (!existing) {
      targetSessionIDs.push(sessionID);
      continue;
    }

    if (existing.lastSeenUpdatedAt !== child.updatedAt) {
      probeStateBySessionID.set(sessionID, {
        attempts: 0,
        lastSeenUpdatedAt: child.updatedAt,
        nextProbeAtMs: nowMs + policy.baseBackoffMs,
      });
      continue;
    }

    if (existing.attempts >= policy.maxAttempts) continue;
    if (nowMs < existing.nextProbeAtMs) continue;
    targetSessionIDs.push(sessionID);
  }

  for (const sessionID of [...probeStateBySessionID.keys()]) {
    if (!activeRunningSessionIDs.has(sessionID)) {
      probeStateBySessionID.delete(sessionID);
    }
  }

  return targetSessionIDs;
}

function settleStaleRunningProbeTargets(
  state: SubagentState,
  probeStateBySessionID: Map<string, StaleRunningProbeState>,
  sessionIDs: string[],
  policy: StaleRunningProbePolicy,
  nowMs: number,
): void {
  for (const sessionID of sessionIDs) {
    const child = Object.values(state.children).find(
      (candidate) => isRealSessionRow(candidate) && sessionIDForChild(candidate) === sessionID,
    );

    if (!child || child.status !== 'running') {
      probeStateBySessionID.delete(sessionID);
      continue;
    }

    const previous = probeStateBySessionID.get(sessionID);
    if (!previous || previous.lastSeenUpdatedAt !== child.updatedAt) {
      const attempts = 1;
      probeStateBySessionID.set(sessionID, {
        attempts,
        lastSeenUpdatedAt: child.updatedAt,
        nextProbeAtMs: nowMs + nextStaleRunningBackoffMs(attempts, policy),
      });
      continue;
    }

    const attempts = previous.attempts + 1;
    probeStateBySessionID.set(sessionID, {
      attempts,
      lastSeenUpdatedAt: child.updatedAt,
      nextProbeAtMs: nowMs + nextStaleRunningBackoffMs(attempts, policy),
    });
  }
}

function resolveRouteSessionID(api: TuiPluginApi): string | undefined {
  return api.route.current.name === 'session' && typeof api.route.current.params?.sessionID === 'string'
    ? api.route.current.params.sessionID
    : undefined;
}

async function hydrateChildStatusesFromClient(
  api: TuiPluginApi,
  state: SubagentState,
  targetSessionIDs: readonly string[],
): Promise<boolean> {
  const sessionClient = api.client.session as unknown as SessionClient | undefined;
  if (!sessionClient) return false;

  const targets = Object.values(state.children).filter((child) => {
    if (!isRealSessionRow(child) || child.status !== 'running') return false;
    const sessionID = sessionIDForChild(child);
    return Boolean(sessionID && targetSessionIDs.includes(sessionID));
  });
  if (targets.length === 0) return false;

  const directory = api.state.path.directory;
  let statusBySessionID: Record<string, unknown> = {};

  try {
    statusBySessionID = (await sessionClient.status?.({ directory }))?.data ?? {};
  } catch {
    statusBySessionID = {};
  }

  let changed = false;

  await Promise.all(
    targets.map(async (child) => {
      const sessionID = sessionIDForChild(child);
      if (!sessionID) return;

      const clientStatus = deriveSessionStatus(statusBySessionID[sessionID]);
      let messageSummary: { status?: 'done' | 'error'; endedAt?: string } = {};

      try {
        const messages = (await sessionClient.messages?.({ sessionID, directory }))?.data ?? [];
        messageSummary = summarizeMessages(messages);
      } catch {
        messageSummary = {};
      }

      const nextStatus = messageSummary.status ?? clientStatus;
      if (!nextStatus) return;

      if (nextStatus === 'running') {
        if (child.endedAt !== undefined) {
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

function hydrateChildStatusesFromTuiState(
  api: TuiPluginApi,
  state: SubagentState,
  targetSessionIDs: readonly string[],
): boolean {
  if (targetSessionIDs.length === 0) return false;

  let changed = false;

  for (const child of Object.values(state.children)) {
    if (!isRealSessionRow(child) || child.status !== 'running') continue;

    const sessionID = child.targetSessionID ?? child.id;
    if (!sessionID || !sessionID.startsWith('ses_')) continue;
    if (!targetSessionIDs.includes(sessionID)) continue;

    const completedAt = completedSessionActivityAt(api, sessionID);
    const latestActivityAt = latestSessionActivityAt(api, sessionID);
    const status = deriveSessionStatus(api.state.session.status(sessionID));

    if (status === 'running') {
      if (child.endedAt !== undefined) {
        child.status = 'running';
        child.endedAt = undefined;
        child.updatedAt = latestActivityAt ?? child.updatedAt;
        changed = true;
      }
      continue;
    }

    if (status === 'error') {
      const endedAt = latestActivityAt ?? child.endedAt ?? child.updatedAt;
      if (child.endedAt !== endedAt || child.updatedAt !== endedAt) {
        child.status = 'error';
        child.endedAt = endedAt;
        child.updatedAt = endedAt;
        changed = true;
      }
      continue;
    }

    if (status === 'done' || completedAt) {
      const endedAt = completedAt ?? latestActivityAt ?? child.endedAt ?? child.updatedAt;
      if (child.endedAt !== endedAt || child.updatedAt !== endedAt) {
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
  options: ResolvedSubagentStatusPluginOptions = normalizeSubagentStatusPluginOptions(undefined),
): TuiRuntime {
  const statePath = resolveStatePath({
    workspaceDirectory: api.state.path.directory,
    statePath: options.persistence.statePath,
  });
  const textPath = resolveTextPath(statePath);
  const persistQueuedSnapshot = createPersistQueue(statePath, textPath);
  const recoverySources = [createSQLiteRecoverySource({ databasePath: options.recovery.sqliteDatabasePath })];
  const staleRunningProbePolicy = options.staleRunningProbePolicy;
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
  const staleRunningProbeStateBySessionID = new Map<string, StaleRunningProbeState>();

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
  }, staleRunningProbePolicy.refreshIntervalMs);

  const bootstrap = async (): Promise<void> => {
    try {
      if (!shouldPreserveStateOnStartup({ preserveStateOnStartup: options.persistence.preserveStateOnStartup })) {
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

export const registerSubagentStatusTui = async (api: TuiPluginApi, options: unknown): Promise<void> => {
  // El contrato del loader expone `options` como unknown; la normalizacion vive
  // en un solo borde para que todo el runtime consuma una forma explicita.
  const resolvedOptions = normalizeSubagentStatusPluginOptions(options);

  createRoot((disposeRoot) => {
    const { slots } = api;
    const [state, setState] = createSignal<SubagentState>(createEmptyState());
    const [sessionId, setSessionId] = createSignal('');
    const [expanded, setExpanded] = createSignal(true);
    const [nowMs, setNowMs] = createSignal(Date.now());
    const snapshot = createMemo(() => buildTuiSnapshot(state(), nowMs()));
    let previousRouteSessionID: string | undefined;
    let pendingSidebarRefocus: { parentSessionID: string; childSessionID: string; childRowID: string } | undefined;
    let activePromptRef: TuiPromptRef | undefined;

    const composePromptRef = (slotRef: PromptRefProp) => {
      return (ref: TuiPromptRef | undefined): void => {
        activePromptRef = ref;
        if (typeof slotRef === 'function') {
          slotRef(ref);
        } else if (slotRef && 'current' in slotRef) {
          slotRef.current = ref;
        }
      };
    };

    const focusActivePrompt = (): void => {
      focusPromptWithDeferredRetry(() => {
        if (!activePromptRef) return false;
        activePromptRef.focus();
        return true;
      });
    };

    const rememberSidebarChildNavigation = (input: {
      parentSessionID: string;
      childSessionID: string;
      childRowID: string;
    }): void => {
      pendingSidebarRefocus = input;
    };

    const runtime = createTuiRuntime(
      api,
      {
        getState: state,
        setState,
        getSessionId: sessionId,
        setSessionId,
        setNowMs,
      },
      resolvedOptions,
    );

    api.lifecycle.onDispose(() => {
      runtime.dispose();
      disposeRoot();
    });

    const disposeCommands = registerSubagentCommands({
      api: api as typeof api & Parameters<typeof registerSubagentCommands>[0]['api'],
      sectionEnabled: expanded,
      setSectionEnabled: (enabled) => setExpanded(enabled),
    });

    api.lifecycle.onDispose(() => {
      disposeCommands();
    });

    createEffect(() => {
      void api.route.current;
      const routeSessionID = resolveRouteSessionID(api);
      const sidebarReturnAction = resolveSidebarReturnFocusAction({
        pendingSidebarRefocus,
        previousRouteSessionID,
        routeSessionID,
      });

      if (sidebarReturnAction === 'focus-prompt') {
        pendingSidebarRefocus = undefined;
        focusActivePrompt();
      } else if (sidebarReturnAction === 'clear-pending') {
        pendingSidebarRefocus = undefined;
      }

      previousRouteSessionID = routeSessionID;
    });

    slots.register({
      order: 120,
      slots: {
        home_prompt(_ctx: TuiSlotContext, props: HomePromptProps) {
          const promptProps = {
            ...props,
            ...(props.workspaceID === undefined && props.workspace_id !== undefined
              ? { workspaceID: props.workspace_id }
              : {}),
            ref: composePromptRef(props.ref),
          };
          return <api.ui.Prompt {...promptProps} />;
        },
        session_prompt(_ctx: TuiSlotContext, props: SessionPromptProps) {
          const nextSessionID = props.sessionID ?? props.session_id;
          const promptProps = {
            ...props,
            ...(props.sessionID === undefined && props.session_id !== undefined ? { sessionID: props.session_id } : {}),
            ...(props.onSubmit === undefined && props.on_submit !== undefined ? { onSubmit: props.on_submit } : {}),
            right:
              props.right ??
              (nextSessionID ? <api.ui.Slot name="session_prompt_right" session_id={nextSessionID} /> : undefined),
            ref: composePromptRef(props.ref),
          };
          return <api.ui.Prompt {...promptProps} />;
        },
        sidebar_content: (_ctx: unknown, slotInput: unknown) => {
          runtime.refreshFromSlot(slotInput);

          return (
            <SidebarView
              api={api}
              snapshot={snapshot}
              totalExecuted={() => state().totalExecuted}
              expanded={expanded()}
              onToggle={() => setExpanded((value) => !value)}
              onNavigateToChild={rememberSidebarChildNavigation}
            />
          );
        },
        home_bottom: () => <HomeBottomView api={api} snapshot={snapshot} totalExecuted={() => state().totalExecuted} />,
      },
    });

    void runtime.bootstrap();
  });
};
