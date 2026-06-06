import type { SubagentChild, SubagentState } from '../types.ts';

import { sanitizeTargetSessionID } from './helpers.ts';

export const resolveSessionIdentity = (
  child: Pick<SubagentChild, 'id'> & Partial<Pick<SubagentChild, 'targetSessionID'>>,
): string | undefined => {
  if (child.id.startsWith('ses_')) return child.id;
  return sanitizeTargetSessionID(child.targetSessionID);
};

const rememberPurgedSession = (
  state: SubagentState,
  child: Pick<SubagentChild, 'id'> & Partial<Pick<SubagentChild, 'targetSessionID'>>,
): void => {
  const sessionId = resolveSessionIdentity(child);
  if (!sessionId) return;
  state.purgedSessionIDs[sessionId] = true;
};

export const clearPurgedSession = (state: SubagentState, sessionId: string): void => {
  delete state.purgedSessionIDs[sessionId];
};

export { rememberPurgedSession };
