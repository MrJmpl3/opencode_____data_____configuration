import type { TuiPluginApi } from '@opencode-ai/plugin/tui';

import type { SubagentChild } from '../domain/types.ts';

import { isSessionTarget, resolveChildSessionID } from './session-target.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function slotSessionId(slotInput: unknown, fallback = ''): string {
  if (!isRecord(slotInput)) return fallback;
  return typeof slotInput.session_id === 'string' ? slotInput.session_id : fallback;
}

export function resolveSessionSlotTransition(
  currentSessionID: string,
  slotInput: unknown,
  hasTrackedChildren: boolean,
): { nextSessionID: string; resetState: boolean; shouldRefresh: boolean } {
  const nextSessionID = slotSessionId(slotInput);
  if (!nextSessionID) {
    return {
      nextSessionID: '',
      resetState: currentSessionID !== '' || hasTrackedChildren,
      shouldRefresh: false,
    };
  }

  if (nextSessionID !== currentSessionID) {
    return {
      nextSessionID,
      resetState: true,
      shouldRefresh: true,
    };
  }

  return {
    nextSessionID,
    resetState: false,
    shouldRefresh: !hasTrackedChildren,
  };
}

export { isSessionTarget } from './session-target.ts';

export function resolveNavigationSessionID(
  child: Pick<SubagentChild, 'id'> & Partial<Pick<SubagentChild, 'targetSessionID'>>,
): string | undefined {
  return resolveChildSessionID(child);
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
