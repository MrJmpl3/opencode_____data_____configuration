/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi, TuiPluginModule, TuiThemeCurrent } from '@opencode-ai/plugin/tui';
import { For, Show, createMemo, createRoot, createSignal } from 'solid-js';

import { applySubagentEvent, installEventBridge } from './events.ts';
import { hydrateDoneChildTokens } from './logs.ts';
import { reconcileChildrenState } from './reconcile.ts';
import {
  byPriority,
  formatContextCompact,
  formatDuration,
  renderStatusLine,
  statusColor as resolveRenderStatusColor,
  visibleSubagentWorkItems,
} from './render.ts';
import {
  createEmptyState,
  loadState,
  mergeChildDetails,
  pruneTerminalChildren,
  resolveStatePath,
  resolveTextPath,
  saveState,
  saveStatusText,
  shouldPreserveStateOnStartup,
} from './state.ts';
import type { SubagentChild, SubagentCounts, SubagentState } from './types.ts';
const PLUGIN_ID = 'mrjmpl3-subagent-status';
const CLOCK_ICON = '';
const TOKEN_ICON = '';
const SIDEBAR_ARROW_EXPANDED = '▼';
const SIDEBAR_ARROW_COLLAPSED = '▶';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function slotSessionId(slotInput: unknown, fallback = ''): string {
  if (!isRecord(slotInput)) return fallback;
  return typeof slotInput.session_id === 'string' ? slotInput.session_id : fallback;
}

export function elapsedMs(child: SubagentChild, now: number): number {
  const startedAt = Date.parse(child.startedAt);
  if (Number.isNaN(startedAt)) return 0;

  if (child.status === 'running') {
    return Math.max(0, now - startedAt);
  }

  const endedAt = Date.parse(child.endedAt ?? child.updatedAt);
  if (Number.isNaN(endedAt)) return 0;
  return Math.max(0, endedAt - startedAt);
}

function taskStatusMarker(status: SubagentChild['status']): string {
  if (status === 'done') return '[✓]';
  if (status === 'error') return '[x]';
  return '[ ]';
}

function themeStatusColor(
  status: SubagentChild['status'],
  theme: Pick<TuiThemeCurrent, 'success' | 'error' | 'warning'>,
): TuiThemeCurrent['success'] {
  if (resolveRenderStatusColor(status) === 'green') return theme.success;
  if (resolveRenderStatusColor(status) === 'red') return theme.error;
  return theme.warning;
}

export function isSessionTarget(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('ses_');
}

export function resolveNavigationSessionID(
  child: Pick<SubagentChild, 'id'> & Partial<Pick<SubagentChild, 'targetSessionID'>>,
): string | undefined {
  if (isSessionTarget(child.targetSessionID)) return child.targetSessionID;
  if (isSessionTarget(child.id)) return child.id;
  return undefined;
}

export function navigateToChildSession(
  api: Pick<TuiPluginApi, 'route'>,
  child: Pick<SubagentChild, 'id'> & Partial<Pick<SubagentChild, 'targetSessionID'>>,
): boolean {
  const sessionID = resolveNavigationSessionID(child);
  if (!sessionID) return false;
  api.route.navigate('session', { sessionID });
  return true;
}

function countsFromChildren(children: readonly SubagentChild[]): SubagentCounts {
  return children.reduce<SubagentCounts>(
    (counts, child) => {
      counts[child.status] += 1;
      return counts;
    },
    { running: 0, done: 0, error: 0 },
  );
}

export function buildTuiSnapshot(
  state: SubagentState,
  nowMs = Date.now(),
): {
  counts: SubagentCounts;
  statusLine: string;
  visibleChildren: SubagentChild[];
} {
  const hydratedChildren = Object.values(state.children).map((child) => ({
    ...child,
    color: child.color ?? resolveRenderStatusColor(child.status),
    elapsedMs: elapsedMs(child, nowMs),
  }));
  const visibleChildren = visibleSubagentWorkItems(hydratedChildren, nowMs).sort(byPriority);
  const counts = countsFromChildren(visibleChildren);
  const statusState: SubagentState = {
    ...state,
    children: Object.fromEntries(visibleChildren.map((child) => [child.id, child])),
  };

  return {
    counts,
    statusLine: renderStatusLine(statusState, nowMs),
    visibleChildren,
  };
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

function messageActivityAt(message: unknown): string | undefined {
  const record = isRecord(message) ? message : undefined;
  const info = isRecord(record?.info) ? record.info : record;
  const time = isRecord(info?.time) ? info.time : undefined;

  return (
    timestampFromUnknown(time?.completed) ?? timestampFromUnknown(time?.updated) ?? timestampFromUnknown(time?.created)
  );
}

function messageInfo(message: unknown): Record<string, unknown> | undefined {
  const record = isRecord(message) ? message : undefined;
  return isRecord(record?.info) ? record.info : record;
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

type SessionClient = {
  status?: (input: { directory: string }) => Promise<{ data?: Record<string, unknown> } | undefined>;
  messages?: (input: { sessionID: string; directory: string }) => Promise<{ data?: unknown[] } | undefined>;
};

function deriveClientSessionStatus(value: unknown): SubagentChild['status'] | undefined {
  const source = isRecord(value) ? (value.type ?? value.status ?? value.state) : value;
  if (typeof source !== 'string') return undefined;

  const status = source.trim().toLowerCase();
  if (status === 'busy' || status === 'retry' || status === 'running' || status === 'pending') return 'running';
  if (status === 'idle' || status === 'done' || status === 'completed' || status === 'complete' || status === 'success')
    return 'done';
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

function formatChildTitle(child: SubagentChild): string {
  const base = child.summary?.trim() || child.title?.trim() || child.id || 'Subagent';
  return child.agentName ? `${base} (${child.agentName})` : base;
}

function hydrateChildStatusesFromTuiState(api: TuiPluginApi, state: SubagentState): boolean {
  let changed = false;

  for (const child of Object.values(state.children)) {
    const sessionID = child.targetSessionID ?? child.id;
    if (!isSessionTarget(sessionID)) continue;

    const completedAt = completedSessionActivityAt(api, sessionID);
    const latestActivityAt = latestSessionActivityAt(api, sessionID);
    const status = api.state.session.status(sessionID)?.type;

    if (status === 'busy' || status === 'retry') {
      if (child.status !== 'running' || child.endedAt !== undefined) {
        child.status = 'running';
        child.endedAt = undefined;
        child.updatedAt = latestActivityAt ?? child.updatedAt;
        changed = true;
      }
      continue;
    }

    if (status === 'idle' || completedAt) {
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

function hydrateChildTokensFromLogs(state: SubagentState): boolean {
  let changed = false;

  for (const child of Object.values(state.children)) {
    if (child.status !== 'done') continue;
    if (child.tokens?.total !== undefined || child.tokens?.input !== undefined || child.tokens?.output !== undefined)
      continue;

    const tokens = hydrateDoneChildTokens(child.id);
    if (!tokens) continue;

    changed = mergeChildDetails(state, child.id, { tokens }) || changed;
  }

  return changed;
}

export async function persistSnapshot(statePath: string, textPath: string, state: SubagentState): Promise<void> {
  try {
    await saveState(statePath, state);
    await saveStatusText(textPath, buildTuiSnapshot(state).statusLine);
  } catch {
    // Persistence is best-effort.
  }
}

const plugin: TuiPluginModule & { id: string } = {
  id: PLUGIN_ID,
  tui: async (api: TuiPluginApi) => {
    createRoot((disposeRoot) => {
      const { slots } = api;
      const [state, setState] = createSignal<SubagentState>(createEmptyState());
      const [sessionId, setSessionId] = createSignal('');
      const [expanded, setExpanded] = createSignal(true);
      const [nowMs, setNowMs] = createSignal(Date.now());
      const snapshot = createMemo(() => buildTuiSnapshot(state(), nowMs()));

      const statePath = resolveStatePath();
      const textPath = resolveTextPath(statePath);

      let disposed = false;
      let tickTimer: ReturnType<typeof setInterval> | undefined;
      let reconcileTimer: ReturnType<typeof setInterval> | undefined;
      let refreshInFlight = false;

      const syncState = async (nextState: SubagentState): Promise<void> => {
        if (disposed) return;
        setState(nextState);
        void persistSnapshot(statePath, textPath, nextState);
      };

      const mergeEventState = async (event: unknown): Promise<void> => {
        if (disposed) return;

        const nextState = structuredClone(state()) as SubagentState;
        const changed = applySubagentEvent(nextState, event);
        if (!changed) return;

        pruneTerminalChildren(nextState);
        await syncState(nextState);
      };

      const refresh = async (sid = sessionId()): Promise<void> => {
        if (disposed) return;
        if (refreshInFlight) return;
        refreshInFlight = true;

        try {
          if (!sid) {
            const emptyState = createEmptyState();
            await syncState(emptyState);
            return;
          }

          const directory = api.state.path.directory;
          const response = await api.client.session?.children?.({ sessionID: sid, directory });
          if (disposed) return;

          const { changed, nextState } = reconcileChildrenState(state(), response);
          const tuiStatusHydrated = hydrateChildStatusesFromTuiState(api, nextState);
          const clientStatusHydrated = await hydrateChildStatusesFromClient(api, nextState);
          const hydrated = hydrateChildTokensFromLogs(nextState);
          const pruned = pruneTerminalChildren(nextState);
          if (!changed && !tuiStatusHydrated && !clientStatusHydrated && !hydrated && !pruned) return;

          await syncState(nextState);
        } finally {
          refreshInFlight = false;
        }
      };

      installEventBridge(api, refresh, (event) => {
        void mergeEventState(event);
      });

      tickTimer = setInterval(() => {
        if (!disposed) setNowMs(Date.now());
      }, 1000);

      reconcileTimer = setInterval(() => {
        if (!disposed && sessionId()) {
          void refresh();
        }
      }, 60_000);

      api.lifecycle.onDispose(() => {
        disposed = true;
        if (tickTimer) clearInterval(tickTimer);
        if (reconcileTimer) clearInterval(reconcileTimer);
        disposeRoot();
      });

      const refreshFromSlot = (slotInput: unknown): void => {
        const sid = slotSessionId(slotInput);
        if (sid && sid !== sessionId()) {
          setSessionId(sid);
          void refresh(sid);
          return;
        }

        if (sid && Object.keys(state().children).length === 0) {
          void refresh(sid);
        }
      };

      const ChildRow = (props: { child: SubagentChild }) => {
        const clickable = createMemo(() => resolveNavigationSessionID(props.child) !== undefined);
        const opacity = createMemo(() => (props.child.status === 'running' ? 1 : 0.68));
        const label = createMemo(() => formatChildTitle(props.child));
        const elapsed = createMemo(() => formatDuration(props.child.elapsedMs));
        const meta = createMemo(() => formatContextCompact(props.child));

        return (
          <box
            flexDirection="column"
            opacity={opacity()}
            onMouseDown={
              clickable()
                ? () => {
                    navigateToChildSession(api, props.child);
                  }
                : undefined
            }
          >
            <box flexDirection="row">
              <text fg={themeStatusColor(props.child.status, api.theme.current)}>
                {taskStatusMarker(props.child.status)}
              </text>
              <text fg={api.theme.current.text}>{` ${label()}`}</text>
            </box>

            <Show
              when={props.child.status === 'running'}
              fallback={
                <box flexDirection="row" paddingLeft={4}>
                  <text fg={api.theme.current.textMuted}>{`↳ ${CLOCK_ICON} ${elapsed()}`}</text>
                  <Show when={meta().length > 0}>
                    <text fg={api.theme.current.textMuted}>{` ${TOKEN_ICON} ${meta()}`}</text>
                  </Show>
                </box>
              }
            >
              <box flexDirection="column">
                <text fg={api.theme.current.textMuted}>{`    ↳ ${CLOCK_ICON} ${elapsed()}`}</text>
                <Show when={meta().length > 0}>
                  <text fg={api.theme.current.textMuted}>{`    ${TOKEN_ICON} ${meta()}`}</text>
                </Show>
              </box>
            </Show>
          </box>
        );
      };

      slots.register({
        order: 120,
        slots: {
          sidebar_content: (_ctx: unknown, slotInput: unknown) => {
            refreshFromSlot(slotInput);
            const currentSnapshot = snapshot();
            const counts = currentSnapshot.counts;

            return (
              <box flexDirection="column">
                <box flexDirection="row">
                  <text
                    fg={api.theme.current.text}
                    selectable={false}
                    onMouseDown={() => setExpanded((value) => !value)}
                  >
                    {`${expanded() ? SIDEBAR_ARROW_EXPANDED : SIDEBAR_ARROW_COLLAPSED} Subagents`}
                  </text>
                </box>
                <box flexDirection="row" paddingRight={1}>
                  <text fg={api.theme.current.warning}>{`● ${counts.running} run`}</text>
                  <text fg={api.theme.current.textMuted}> · </text>
                  <text fg={api.theme.current.success}>{`✓ ${counts.done} done`}</text>
                  <text fg={api.theme.current.textMuted}> · </text>
                  <text fg={api.theme.current.error}>{`✕ ${counts.error} err`}</text>
                  <text fg={api.theme.current.textMuted}> · </text>
                  <text fg={api.theme.current.text}>{`Σ ${state().totalExecuted}`}</text>
                </box>

                <Show when={expanded()}>
                  <box flexDirection="column">
                    <Show
                      when={currentSnapshot.visibleChildren.length > 0}
                      fallback={<text fg={api.theme.current.textMuted}>No subagents yet</text>}
                    >
                      <For each={currentSnapshot.visibleChildren}>{(child) => <ChildRow child={child} />}</For>
                    </Show>
                  </box>
                </Show>
              </box>
            );
          },
          home_bottom: () => {
            const counts = snapshot().counts;
            if (counts.running + counts.done + counts.error === 0) return undefined;

            return (
              <box paddingLeft={1} paddingRight={1}>
                <box flexDirection="row">
                  <text fg={api.theme.current.warning}>{`● ${counts.running}`}</text>
                  <text fg={api.theme.current.textMuted}> · </text>
                  <text fg={api.theme.current.success}>{`✓ ${counts.done}`}</text>
                  <text fg={api.theme.current.textMuted}> · </text>
                  <text fg={api.theme.current.error}>{`✕ ${counts.error}`}</text>
                  <text fg={api.theme.current.textMuted}> · </text>
                  <text fg={api.theme.current.text}>{`Σ ${state().totalExecuted}`}</text>
                </box>
              </box>
            );
          },
        },
      });

      void (async () => {
        if (!shouldPreserveStateOnStartup()) {
          await syncState(createEmptyState());
        } else {
          await syncState(await loadState(statePath));
        }

        void refresh(sessionId());
      })();
    });
  },
};

export default plugin;
