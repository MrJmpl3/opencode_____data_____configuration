import type { TuiPluginApi } from '@opencode-ai/plugin/tui';

import type { SubagentChild } from '../domain/types.ts';
import { isRecord } from '../shared/coercion.ts';

import { resolveChildSessionId } from './session-target.ts';

const slotSessionId = (slotInput: unknown, fallback = ''): string => {
  if (!isRecord(slotInput)) return fallback;

  if (typeof slotInput.session_id === 'string') return slotInput.session_id;
  if (typeof slotInput.sessionID === 'string') return slotInput.sessionID;
  if (typeof slotInput.sessionId === 'string') return slotInput.sessionId;

  return fallback;
};

export const resolveSessionSlotTransition = (
  currentSessionId: string,
  slotInput: unknown,
  hasTrackedChildren: boolean,
): { nextSessionId: string; resetState: boolean; shouldRefresh: boolean } => {
  const nextSessionId = slotSessionId(slotInput);
  if (!nextSessionId) {
    return {
      nextSessionId: '',
      resetState: currentSessionId !== '' || hasTrackedChildren,
      shouldRefresh: false,
    };
  }

  if (nextSessionId !== currentSessionId) {
    return {
      nextSessionId,
      resetState: true,
      shouldRefresh: true,
    };
  }

  return {
    nextSessionId,
    resetState: false,
    shouldRefresh: !hasTrackedChildren,
  };
};

export { isSessionTarget } from './session-target.ts';

export const resolveNavigationSessionId = (
  child: Pick<SubagentChild, 'id'> & Partial<Pick<SubagentChild, 'targetSessionID'>>,
): string | undefined => {
  return resolveChildSessionId(child);
};

export const navigateToChildSession = (
  api: Pick<TuiPluginApi, 'route'>,
  child: Pick<SubagentChild, 'id'> & Partial<Pick<SubagentChild, 'targetSessionID'>>,
): boolean => {
  const sessionId = resolveNavigationSessionId(child);
  if (!sessionId) return false;

  api.route.navigate('session', { sessionID: sessionId });
  return true;
};
