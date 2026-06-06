import type { SubagentChild, SubagentState } from '../types.ts';

import { toNonNegativeInteger } from './helpers.ts';
import {
  isDelegationLikeChild,
  isRealSessionChild,
  isSubtaskFallback,
  isSyntheticToolWrapper,
} from './child-kind.ts';

const normalizeExecutionCounters = (state: SubagentState): void => {
  state.totalExecuted = Math.max(
    toNonNegativeInteger(state.totalExecuted) ?? 0,
    Object.keys(state.countedChildIDs).length,
  );
};

const matchingCorrelation = (
  left: Pick<SubagentChild, 'parentID'> & Partial<Pick<SubagentChild, 'messageID'>>,
  right: Pick<SubagentChild, 'parentID'> & Partial<Pick<SubagentChild, 'messageID'>>,
): boolean =>
  Boolean(
    left.messageID && right.messageID && left.parentID === right.parentID && left.messageID === right.messageID,
  );

const findMatchingCountedSessionID = (
  state: SubagentState,
  subtask: Pick<SubagentChild, 'parentID'> & Partial<Pick<SubagentChild, 'messageID' | 'targetSessionID'>>,
): string | undefined => {
  if (subtask.targetSessionID && state.countedChildIDs[subtask.targetSessionID]) {
    return subtask.targetSessionID;
  }

  const matches = Object.values(state.children)
    .filter((child) => isRealSessionChild(child))
    .filter((child) => state.countedChildIDs[child.id])
    .filter((child) => matchingCorrelation(subtask, child))
    .map((child) => child.id);

  return matches.length === 1 ? matches[0] : undefined;
};

const findMatchingCountedSubtaskID = (
  state: SubagentState,
  session: Pick<SubagentChild, 'id' | 'parentID'> & Partial<Pick<SubagentChild, 'messageID'>>,
): string | undefined => {
  const byTarget = Object.values(state.children)
    .filter((child) => isSubtaskFallback(child))
    .filter((child) => state.countedChildIDs[child.id])
    .filter((child) => child.targetSessionID === session.id)
    .map((child) => child.id);
  if (byTarget.length === 1) return byTarget[0];

  const byCorrelation = Object.values(state.children)
    .filter((child) => isSubtaskFallback(child))
    .filter((child) => state.countedChildIDs[child.id])
    .filter((child) => matchingCorrelation(session, child))
    .map((child) => child.id);

  return byCorrelation.length === 1 ? byCorrelation[0] : undefined;
};

const pruneStaleCountedChildIDs = (state: SubagentState): boolean => {
  let changed = false;

  for (const childID of Object.keys(state.countedChildIDs)) {
    if (state.children[childID]) continue;
    delete state.countedChildIDs[childID];
    changed = true;
  }

  return changed;
};

export const rekeyCountedExecution = (state: SubagentState, fromID: string, toID: string): boolean => {
  if (fromID === toID || !state.countedChildIDs[fromID]) return false;

  const toAlreadyCounted = Boolean(state.countedChildIDs[toID]);
  delete state.countedChildIDs[fromID];
  if (!toAlreadyCounted) {
    state.countedChildIDs[toID] = true;
    normalizeExecutionCounters(state);
    return true;
  }

  state.totalExecuted = Math.max(
    Object.keys(state.countedChildIDs).length,
    (toNonNegativeInteger(state.totalExecuted) ?? 0) - 1,
  );
  return true;
};

export const resolveExecutionCountIdentity = (
  state: SubagentState,
  child: Pick<SubagentChild, 'id' | 'title' | 'parentID'> &
    Partial<Pick<SubagentChild, 'messageID' | 'source' | 'targetSessionID'>>,
): string | undefined => {
  if (isSyntheticToolWrapper(child) || isDelegationLikeChild(child)) return undefined;

  if (isRealSessionChild(child)) {
    const matchingSubtaskID = findMatchingCountedSubtaskID(state, child);
    if (matchingSubtaskID) {
      rekeyCountedExecution(state, matchingSubtaskID, child.id);
      return undefined;
    }

    return child.id;
  }

  if (isSubtaskFallback(child)) {
    if (findMatchingCountedSessionID(state, child)) return undefined;
    return child.targetSessionID ?? child.id;
  }

  return child.id;
};

export const syncExecutionState = (state: SubagentState): void => {
  pruneStaleCountedChildIDs(state);
  normalizeExecutionCounters(state);
};
