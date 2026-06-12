/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi, TuiThemeCurrent } from '@opencode-ai/plugin/tui';
import type { JSX } from 'solid-js';
import { For, Show, createMemo } from 'solid-js';

import type { SubagentChild } from '../domain/types.ts';
import type { TuiSnapshot } from '../runtime/snapshot.ts';
import { t } from '../runtime/i18n.ts';
import { navigateToChildSession, resolveNavigationSessionId } from '../runtime/navigation.ts';
import {
  formatCount,
  formatSidebarCompactCount,
  formatSidebarRunningMeta,
  formatSidebarSectionHeading,
  formatSidebarTerminalMeta,
  formatSidebarTitle,
  statusColor as resolveRenderStatusColor,
} from './format.ts';
import { splitSidebarVisibleSections } from './view-model/visibility.ts';

const SIDEBAR_ARROW_EXPANDED = '▼';
const SIDEBAR_ARROW_COLLAPSED = '▶';
const ROW_NAVIGATION_HINT = '›';

const SidebarSection = (props: {
  api: TuiPluginApi;
  label: string;
  count: number;
  tone: TuiThemeCurrent['text'];
  children: JSX.Element;
}) => (
  <box flexDirection="column">
    <box flexDirection="row">
      <text fg={props.tone}>{formatSidebarSectionHeading(props.label, props.count)}</text>
    </box>
    <box flexDirection="column">{props.children}</box>
  </box>
);

const taskStatusMarker = (status: SubagentChild['status']): string => {
  if (status === 'done') return '✓';
  if (status === 'error') return '✕';
  if (status === 'stale') return '✕';
  return '●';
};

const themeStatusColor = (
  status: SubagentChild['status'],
  theme: Pick<TuiThemeCurrent, 'success' | 'error' | 'warning' | 'textMuted'>,
): TuiThemeCurrent['success'] => {
  if (status === 'stale') return theme.error;
  if (resolveRenderStatusColor(status) === 'green') return theme.success;
  if (resolveRenderStatusColor(status) === 'red') return theme.error;
  if (resolveRenderStatusColor(status) === 'gray') return theme.textMuted;
  return theme.warning;
};

const ChildRow = (props: {
  api: TuiPluginApi;
  child: SubagentChild;
  onNavigateToChild?: (input: { parentSessionID: string; childSessionID: string; childRowID: string }) => void;
}) => {
  const clickable = createMemo(() => resolveNavigationSessionId(props.child) !== undefined);
  const opacity = createMemo(() => {
    if (props.child.status === 'running') return 1;
    if (props.child.status === 'error' || props.child.status === 'stale') return 0.88;
    return 0.58;
  });
  const title = createMemo(() => formatSidebarTitle(props.child, clickable()));
  const runningMeta = createMemo(() => formatSidebarRunningMeta(props.child));
  const terminalMeta = createMemo(() => formatSidebarTerminalMeta(props.child));
  const titleColor = createMemo(() => {
    if (props.child.status === 'done') return props.api.theme.current.textMuted;
    return props.api.theme.current.text;
  });
  const metaColor = createMemo(() => {
    if (props.child.status === 'error' || props.child.status === 'stale') return props.api.theme.current.error;
    return props.api.theme.current.textMuted;
  });

  return (
    <box
      flexDirection="column"
      opacity={opacity()}
      onMouseUp={
        clickable()
          ? () => {
              const childSessionId = resolveNavigationSessionId(props.child);
              if (childSessionId) {
                props.onNavigateToChild?.({
                  parentSessionID: props.child.parentID,
                  childSessionID: childSessionId,
                  childRowID: props.child.id,
                });
              }
              navigateToChildSession(props.api, props.child);
            }
          : undefined
      }
    >
      <box flexDirection="row">
        <text fg={themeStatusColor(props.child.status, props.api.theme.current)}>
          {taskStatusMarker(props.child.status)}
        </text>
        <text fg={titleColor()}>{` ${title()}`}</text>
        <Show when={clickable()}>
          <text fg={props.api.theme.current.textMuted}>{` ${ROW_NAVIGATION_HINT}`}</text>
        </Show>
      </box>

      <Show
        when={props.child.status === 'running'}
        fallback={
          <Show when={terminalMeta().length > 0}>
            <text fg={metaColor()}>{`  ${terminalMeta()}`}</text>
          </Show>
        }
      >
        <Show when={runningMeta().length > 0}>
          <text fg={props.api.theme.current.textMuted}>{`  ${runningMeta()}`}</text>
        </Show>
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
  onNavigateToChild?: (input: { parentSessionID: string; childSessionID: string; childRowID: string }) => void;
}) => {
  const currentSnapshot = () => props.snapshot();
  const counts = () => currentSnapshot().counts;
  const sections = createMemo(() => splitSidebarVisibleSections(currentSnapshot().visibleChildren));

  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <text fg={props.api.theme.current.text} selectable={false} onMouseDown={props.onToggle}>
          {`${props.expanded ? SIDEBAR_ARROW_EXPANDED : SIDEBAR_ARROW_COLLAPSED} ${t('subagents')} · Σ ${formatSidebarCompactCount(props.totalExecuted())}`}
        </text>
      </box>
      <box flexDirection="row" paddingRight={1}>
        <text fg={props.api.theme.current.warning}>{`● ${formatSidebarCompactCount(counts().running)}`}</text>
        <text fg={props.api.theme.current.textMuted}> </text>
        <text fg={props.api.theme.current.success}>{`✓ ${formatSidebarCompactCount(counts().done)}`}</text>
        <text fg={props.api.theme.current.textMuted}> </text>
        <text
          fg={props.api.theme.current.error}
        >{`✕ ${formatSidebarCompactCount(counts().error + counts().stale)}`}</text>
      </box>

      <Show when={props.expanded}>
        <box flexDirection="column">
          <Show
            when={currentSnapshot().visibleChildren.length > 0}
            fallback={<text fg={props.api.theme.current.textMuted}>{t('noSubagentsYet')}</text>}
          >
            <Show when={sections().active.length > 0}>
              <SidebarSection
                api={props.api}
                label={t('active')}
                count={sections().active.length}
                tone={props.api.theme.current.warning}
              >
                <For each={sections().active}>
                  {(child) => <ChildRow api={props.api} child={child} onNavigateToChild={props.onNavigateToChild} />}
                </For>
              </SidebarSection>
            </Show>
            <Show when={sections().recent.length > 0}>
              <SidebarSection
                api={props.api}
                label={t('recent')}
                count={sections().recent.length}
                tone={props.api.theme.current.textMuted}
              >
                <For each={sections().recent}>
                  {(child) => <ChildRow api={props.api} child={child} onNavigateToChild={props.onNavigateToChild} />}
                </For>
              </SidebarSection>
            </Show>
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
  if (counts().running + counts().done + counts().error + counts().stale === 0) return undefined;

  return (
    <box paddingLeft={1} paddingRight={1}>
      <box flexDirection="row">
        <text fg={props.api.theme.current.warning}>{`● ${formatCount(counts().running)}`}</text>
        <text fg={props.api.theme.current.textMuted}> · </text>
        <text fg={props.api.theme.current.success}>{`✓ ${formatCount(counts().done)}`}</text>
        <text fg={props.api.theme.current.textMuted}> · </text>
        <text fg={props.api.theme.current.error}>{`✕ ${formatCount(counts().error + counts().stale)}`}</text>
        <text fg={props.api.theme.current.textMuted}> · </text>
        <text fg={props.api.theme.current.text}>{`Σ ${formatCount(props.totalExecuted())}`}</text>
      </box>
    </box>
  );
};
