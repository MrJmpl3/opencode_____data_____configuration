import type { SubagentChild, SubagentState } from '../types.ts';

import { isRealSessionChild, isSubtaskFallback, isSyntheticToolWrapper } from './child-kind.ts';
import { syncExecutionState } from './execution-count.ts';
import { terminalChildTimestamp } from './helpers.ts';
import { rememberPurgedSession } from './session-identity.ts';

const TERMINAL_CHILD_RETENTION_MS = 30 * 60 * 1000;
const MAX_TERMINAL_CHILDREN = 50;

export const pruneTerminalChildren = (state: SubagentState, now = Date.now()): boolean => {
  const terminalChildren = Object.values(state.children)
    .filter((child) => child.status !== 'running')
    .sort((left, right) => terminalChildTimestamp(right) - terminalChildTimestamp(left));
  if (terminalChildren.length === 0) return false;

  const cutoff = now - TERMINAL_CHILD_RETENTION_MS;
  const keepIDs = new Set(
    terminalChildren
      .filter((child) => terminalChildTimestamp(child) >= cutoff)
      .slice(0, MAX_TERMINAL_CHILDREN)
      .map((child) => child.id),
  );

  let changed = false;
  for (const child of terminalChildren) {
    if (keepIDs.has(child.id)) continue;
    rememberPurgedSession(state, child);
    delete state.children[child.id];
    changed = true;
  }

  syncExecutionState(state);

  return changed;
};

export const pruneOrphanedSyntheticRunningChildren = (
  state: SubagentState,
  options: { pruneWhenNoRealSessionChildren?: boolean } = {},
): boolean => {
  const realSessionChildren = Object.values(state.children).filter((child) => isRealSessionChild(child));
  const pruneToolWrappersWithoutRealSessions =
    realSessionChildren.length === 0 && !options.pruneWhenNoRealSessionChildren;

  const activeSessionIDs = new Set(
    realSessionChildren.filter((child) => child.status === 'running').map((child) => child.id),
  );

  let changed = false;
  for (const child of Object.values(state.children)) {
    if (child.status !== 'running') continue;
    if (!isSyntheticToolWrapper(child) && !isSubtaskFallback(child)) continue;

    if (pruneToolWrappersWithoutRealSessions && isSubtaskFallback(child)) {
      continue;
    }

    const anchoredToActiveSession =
      activeSessionIDs.has(child.parentID) || activeSessionIDs.has(child.targetSessionID ?? '');
    if (anchoredToActiveSession) continue;

    rememberPurgedSession(state, child);
    delete state.children[child.id];
    changed = true;
  }

  syncExecutionState(state);

  return changed;
};
