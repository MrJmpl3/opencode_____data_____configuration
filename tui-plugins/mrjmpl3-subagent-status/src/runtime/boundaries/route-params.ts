import type { TuiRouteCurrent } from '@opencode-ai/plugin/tui';

import { asString, isRecord } from '../../shared/coercion.ts';

export type NormalizedSessionRouteParams = {
  sessionID?: string;
};

export const normalizeSessionRouteParams = (route: TuiRouteCurrent): NormalizedSessionRouteParams => {
  if (route.name === 'session') {
    return {
      sessionID: asString(route.params?.sessionID),
    };
  }

  if (!('params' in route) || !isRecord(route.params)) {
    return {};
  }

  const params: Record<string, unknown> = route.params;

  return {
    sessionID: asString(params.sessionID) ?? asString(params.session_id) ?? asString(params.sessionId),
  };
};

export const resolveRouteSessionId = (route: TuiRouteCurrent): string | undefined => {
  return normalizeSessionRouteParams(route).sessionID;
};
