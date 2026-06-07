import type { TuiPluginApi } from '@opencode-ai/plugin/tui';

import type { SubagentChild } from '../domain/types.ts';
import { resolveSlotSessionId } from './boundaries/slot-payload.ts';

import { resolveChildSessionId } from './session-target.ts';

export const resolveSessionSlotTransition = (
  currentSessionId: string,
  slotInput: unknown,
  hasTrackedChildren: boolean,
): { nextSessionId: string; resetState: boolean; shouldRefresh: boolean } => {
  const nextSessionId = resolveSlotSessionId(slotInput);
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
