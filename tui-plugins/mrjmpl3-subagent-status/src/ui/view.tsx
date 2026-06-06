/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi, TuiThemeCurrent } from '@opencode-ai/plugin/tui';
import type { JSX } from 'solid-js';
import { For, Show, createMemo } from 'solid-js';

import type { SubagentChild } from '../domain/types.ts';
import type { TuiSnapshot } from '../runtime/snapshot.ts';
import { t } from '../runtime/i18n.ts';
import {
  formatCount,
  formatSidebarRunningMeta,
  formatSidebarTerminalMeta,
  formatSidebarTitle,
  statusColor as resolveRenderStatusColor,
} from './format.ts';
import { navigateToChildSession, resolveNavigationSessionID } from '../runtime/navigation.ts';
import { splitSidebarVisibleSections } from './view-model.ts';

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
      <text fg={props.tone}>{props.label}</text>
      <text fg={props.api.theme.current.textMuted}>{` · ${formatCount(props.count)}`}</text>
    </box>
    <box flexDirection="column">{props.children}</box>
  </box>
);

function taskStatusMarker(status: SubagentChild['status']): string {
  if (status === 'done') return '✓';
  if (status === 'error') return '✕';
  return '●';
}

function themeStatusColor(
  status: SubagentChild['status'],
  theme: Pick<TuiThemeCurrent, 'success' | 'error' | 'warning'>,
): TuiThemeCurrent['success'] {
  if (resolveRenderStatusColor(status) === 'green') return theme.success;
  if (resolveRenderStatusColor(status) === 'red') return theme.error;
  return theme.warning;
}

const ChildRow = (props: {
  api: TuiPluginApi;
  child: SubagentChild;
  onNavigateToChild?: (input: { parentSessionID: string; childSessionID: string; childRowID: string }) => void;
}) => {
  const clickable = createMemo(() => resolveNavigationSessionID(props.child) !== undefined);
  const opacity = createMemo(() => {
    if (props.child.status === 'running') return 1;
    if (props.child.status === 'error') return 0.88;
    return 0.58;
  });
  const title = createMemo(() => formatSidebarTitle(props.child));
  const runningMeta = createMemo(() => formatSidebarRunningMeta(props.child));
  const terminalMeta = createMemo(() => formatSidebarTerminalMeta(props.child));
  const titleColor = createMemo(() => {
    if (props.child.status === 'done') return props.api.theme.current.textMuted;
    return props.api.theme.current.text;
  });
  const metaColor = createMemo(() => {
    if (props.child.status === 'error') return props.api.theme.current.error;
    return props.api.theme.current.textMuted;
  });

  return (
    <box
      flexDirection="column"
      opacity={opacity()}
      onMouseUp={
        clickable()
          ? () => {
              const childSessionID = resolveNavigationSessionID(props.child);
              if (childSessionID) {
                props.onNavigateToChild?.({
                  parentSessionID: props.child.parentID,
                  childSessionID,
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
        <box flexDirection="column">
          <Show when={runningMeta().primary.length > 0}>
            <text fg={props.api.theme.current.textMuted}>{`  ${runningMeta().primary}`}</text>
          </Show>
          <Show when={runningMeta().secondary.length > 0}>
            <text fg={props.api.theme.current.textMuted}>{`  ${runningMeta().secondary}`}</text>
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
  onNavigateToChild?: (input: { parentSessionID: string; childSessionID: string; childRowID: string }) => void;
}) => {
  const currentSnapshot = () => props.snapshot();
  const counts = () => currentSnapshot().counts;
  const sections = createMemo(() => splitSidebarVisibleSections(currentSnapshot().visibleChildren));

  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <text fg={props.api.theme.current.text} selectable={false} onMouseDown={props.onToggle}>
          {`${props.expanded ? SIDEBAR_ARROW_EXPANDED : SIDEBAR_ARROW_COLLAPSED} ${t('subagents')}`}
        </text>
      </box>
      <box flexDirection="row" paddingRight={1}>
        <text fg={props.api.theme.current.warning}>{`● ${formatCount(counts().running)} ${t('run')}`}</text>
        <text fg={props.api.theme.current.textMuted}> · </text>
        <text fg={props.api.theme.current.success}>{`✓ ${formatCount(counts().done)} ${t('done')}`}</text>
        <text fg={props.api.theme.current.textMuted}> · </text>
        <text fg={props.api.theme.current.error}>{`✕ ${formatCount(counts().error)} ${t('err')}`}</text>
        <text fg={props.api.theme.current.textMuted}> · </text>
        <text fg={props.api.theme.current.text}>{`Σ${formatCount(props.totalExecuted())}`}</text>
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
  if (counts().running + counts().done + counts().error === 0) return undefined;

  return (
    <box paddingLeft={1} paddingRight={1}>
      <box flexDirection="row">
        <text fg={props.api.theme.current.warning}>{`● ${formatCount(counts().running)}`}</text>
        <text fg={props.api.theme.current.textMuted}> · </text>
        <text fg={props.api.theme.current.success}>{`✓ ${formatCount(counts().done)}`}</text>
        <text fg={props.api.theme.current.textMuted}> · </text>
        <text fg={props.api.theme.current.error}>{`✕ ${formatCount(counts().error)}`}</text>
        <text fg={props.api.theme.current.textMuted}> · </text>
        <text fg={props.api.theme.current.text}>{`Σ${formatCount(props.totalExecuted())}`}</text>
      </box>
    </box>
  );
};
