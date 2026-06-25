import { asString, isPlainObject as isRecord } from '@mrjmpl3/tui-kit';

export type NormalizedSessionSlotPayload = {
  sessionID?: string;
};

export const normalizeSessionSlotPayload = (input: unknown): NormalizedSessionSlotPayload => {
  if (!isRecord(input)) {
    return {};
  }

  return {
    sessionID: asString(input.sessionID) ?? asString(input.session_id) ?? asString(input.sessionId),
  };
};

export const resolveSlotSessionId = (input: unknown, fallback = ''): string => {
  return normalizeSessionSlotPayload(input).sessionID ?? fallback;
};
