/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi, TuiThemeCurrent } from '@opencode-ai/plugin/tui';
import { For, Show, createMemo } from 'solid-js';

import type { SubagentChild } from '../state/types.ts';
import type { TuiSnapshot } from './snapshot.ts';
import { formatContextCompact, formatDuration, statusColor as resolveRenderStatusColor } from './format.ts';
import { navigateToChildSession, resolveNavigationSessionID } from './navigation.ts';

const CLOCK_ICON = '';
const TOKEN_ICON = '';
const SIDEBAR_ARROW_EXPANDED = '▼';
const SIDEBAR_ARROW_COLLAPSED = '▶';

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

function formatChildTitle(child: SubagentChild): string {
  const base = child.summary?.trim() || child.title?.trim() || child.id || 'Subagent';
  return child.agentName ? `${base} (${child.agentName})` : base;
}

const ChildRow = (props: { api: TuiPluginApi; child: SubagentChild }) => {
  const clickable = createMemo(() => resolveNavigationSessionID(props.child) !== undefined);
  const opacity = createMemo(() => (props.child.status === 'running' ? 1 : 0.68));
  const label = createMemo(() => formatChildTitle(props.child));
  const elapsed = createMemo(() => formatDuration(props.child.elapsedMs));
  const meta = createMemo(() => formatContextCompact(props.child));

  return (
    <box
      flexDirection="column"
      opacity={opacity()}
      onMouseUp={
        clickable()
          ? () => {
              navigateToChildSession(props.api, props.child);
            }
          : undefined
      }
    >
      <box flexDirection="row">
        <text fg={themeStatusColor(props.child.status, props.api.theme.current)}>{taskStatusMarker(props.child.status)}</text>
        <text fg={props.api.theme.current.text}>{` ${label()}`}</text>
      </box>

      <Show
        when={props.child.status === 'running'}
        fallback={
          <box flexDirection="row" paddingLeft={4}>
            <text fg={props.api.theme.current.textMuted}>{`↳ ${CLOCK_ICON} ${elapsed()}`}</text>
            <Show when={meta().length > 0}>
              <text fg={props.api.theme.current.textMuted}>{` ${TOKEN_ICON} ${meta()}`}</text>
            </Show>
          </box>
        }
      >
        <box flexDirection="column">
          <text fg={props.api.theme.current.textMuted}>{`    ↳ ${CLOCK_ICON} ${elapsed()}`}</text>
          <Show when={meta().length > 0}>
            <text fg={props.api.theme.current.textMuted}>{`    ${TOKEN_ICON} ${meta()}`}</text>
          </Show>
        </box>
      </Show>
    </box>
  );
};

export const SidebarView = (props: {
  api: TuiPluginApi;
  snapshot: () => TuiSnapshot;
  totalExecuted: () => number;
  expanded: boolean;
  onToggle: () => void;
}) => {
  const currentSnapshot = () => props.snapshot();
  const counts = () => currentSnapshot().counts;

  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <text fg={props.api.theme.current.text} selectable={false} onMouseDown={props.onToggle}>
          {`${props.expanded ? SIDEBAR_ARROW_EXPANDED : SIDEBAR_ARROW_COLLAPSED} Subagents`}
        </text>
      </box>
      <box flexDirection="row" paddingRight={1}>
        <text fg={props.api.theme.current.warning}>{`● ${counts().running} run`}</text>
        <text fg={props.api.theme.current.textMuted}> · </text>
        <text fg={props.api.theme.current.success}>{`✓ ${counts().done} done`}</text>
        <text fg={props.api.theme.current.textMuted}> · </text>
        <text fg={props.api.theme.current.error}>{`✕ ${counts().error} err`}</text>
        <text fg={props.api.theme.current.textMuted}> · </text>
        <text fg={props.api.theme.current.text}>{`Σ ${props.totalExecuted()}`}</text>
      </box>

      <Show when={props.expanded}>
        <box flexDirection="column">
          <Show
            when={currentSnapshot().visibleChildren.length > 0}
            fallback={<text fg={props.api.theme.current.textMuted}>No subagents yet</text>}
          >
            <For each={currentSnapshot().visibleChildren}>{(child) => <ChildRow api={props.api} child={child} />}</For>
          </Show>
        </box>
      </Show>
    </box>
  );
};

export const HomeBottomView = (props: {
  api: TuiPluginApi;
  snapshot: () => TuiSnapshot;
  totalExecuted: () => number;
}) => {
  const counts = () => props.snapshot().counts;
  if (counts().running + counts().done + counts().error === 0) return undefined;

  return (
    <box paddingLeft={1} paddingRight={1}>
      <box flexDirection="row">
        <text fg={props.api.theme.current.warning}>{`● ${counts().running}`}</text>
        <text fg={props.api.theme.current.textMuted}> · </text>
        <text fg={props.api.theme.current.success}>{`✓ ${counts().done}`}</text>
        <text fg={props.api.theme.current.textMuted}> · </text>
        <text fg={props.api.theme.current.error}>{`✕ ${counts().error}`}</text>
        <text fg={props.api.theme.current.textMuted}> · </text>
        <text fg={props.api.theme.current.text}>{`Σ ${props.totalExecuted()}`}</text>
      </box>
    </box>
  );
};
