import {
  clearPurgedSession,
  markChildStatus,
  mergeChildDetails,
  syncExecutionState,
  upsertRunningChild,
} from '../domain/state.ts';
import type { SubagentChild, SubagentState } from '../domain/types.ts';

export type RecoveryContext = {
  directory: string;
  parentSessionID?: string;
};

export type RecoveryResult = {
  changed: boolean;
  authoritativeSessionIDs: string[];
};

export interface RecoverySource {
  hydrateState(
    state: SubagentState,
    context: RecoveryContext,
  ): Promise<RecoveryResult | undefined> | RecoveryResult | undefined;
}

const resolveSessionIdentity = (
  child: Pick<SubagentChild, 'id'> & Partial<Pick<SubagentChild, 'targetSessionID'>>,
): string | undefined => {
  if (child.id.startsWith('ses_')) return child.id;
  return child.targetSessionID;
};

const isRealSessionChild = (child: Pick<SubagentChild, 'id'> & Partial<Pick<SubagentChild, 'source'>>): boolean => {
  return child.source === 'session' || child.id.startsWith('ses_');
};

export const inferParentSessionID = (state: SubagentState): string | undefined => {
  const parentIDs = new Set(Object.values(state.children).map((child) => child.parentID));
  return parentIDs.size === 1 ? [...parentIDs][0] : undefined;
};

export const applyRecoveredChildren = (
  state: SubagentState,
  children: SubagentChild[],
  authoritativeSessionIDs: string[],
  parentSessionID?: string,
): RecoveryResult => {
  let changed = false;
  const authoritativeSet = new Set(authoritativeSessionIDs);

  for (const child of children) {
    clearPurgedSession(state, child.id);
    changed = upsertRunningChild(state, child, { allowPurgedSessionRestore: true }) || changed;
    changed =
      mergeChildDetails(state, child.id, {
        agentName: child.agentName,
        summary: child.summary,
        targetSessionID: child.targetSessionID,
        tokens: child.tokens,
        updatedAt: child.updatedAt,
      }) || changed;

    if (child.status !== 'running') {
      changed = markChildStatus(state, child.id, child.status, child.endedAt ?? child.updatedAt) || changed;
    }
  }

  for (const child of Object.values(state.children)) {
    if (parentSessionID && child.parentID !== parentSessionID) continue;

    const sessionId = resolveSessionIdentity(child);
    if (!sessionId || authoritativeSet.has(sessionId)) continue;
    if (isRealSessionChild(child) && child.status === 'running') continue;

    delete state.children[child.id];
    state.purgedSessionIDs[sessionId] = true;
    changed = true;
  }

  syncExecutionState(state);

  return {
    changed,
    authoritativeSessionIDs,
  };
};

export const hydrateStateFromRecoverySources = async (
  state: SubagentState,
  context: RecoveryContext,
  recoverySources: RecoverySource[],
): Promise<RecoveryResult> => {
  let changed = false;
  const authoritativeSessionIDs = new Set<string>();

  for (const recoverySource of recoverySources) {
    const result = await recoverySource.hydrateState(state, context);
    if (!result) continue;

    changed = result.changed || changed;
    for (const sessionId of result.authoritativeSessionIDs) {
      authoritativeSessionIDs.add(sessionId);
    }
  }

  return {
    changed,
    authoritativeSessionIDs: [...authoritativeSessionIDs],
  };
};
