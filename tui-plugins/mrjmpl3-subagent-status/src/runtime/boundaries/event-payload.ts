import { isPlainObject as isRecord } from '@mrjmpl3/tui-kit';

export type EventLike = {
  type?: unknown;
  title?: unknown;
  name?: unknown;
  sessionID?: unknown;
  session_id?: unknown;
  sessionId?: unknown;
  status?: unknown;
  state?: unknown;
  parentID?: unknown;
  properties?: {
    id?: unknown;
    sessionID?: unknown;
    session_id?: unknown;
    sessionId?: unknown;
    title?: unknown;
    name?: unknown;
    parentID?: unknown;
    status?: unknown;
    state?: unknown;
    info?: {
      id?: unknown;
      title?: unknown;
      name?: unknown;
      agent?: unknown;
      subagent_type?: unknown;
      sessionID?: unknown;
      session_id?: unknown;
      sessionId?: unknown;
      parentID?: unknown;
      status?: unknown;
      state?: unknown;
      time?: Record<string, unknown>;
    };
    part?: Record<string, unknown>;
  };
  [key: string]: unknown;
};

const normalizeEventInfo = (input: unknown): NonNullable<EventLike['properties']>['info'] | undefined => {
  if (!isRecord(input)) {
    return undefined;
  }

  return {
    ...input,
    time: isRecord(input.time) ? input.time : undefined,
  };
};

const normalizeEventProperties = (input: unknown): EventLike['properties'] | undefined => {
  if (!isRecord(input)) {
    return undefined;
  }

  return {
    ...input,
    info: normalizeEventInfo(input.info),
    part: isRecord(input.part) ? input.part : undefined,
  };
};

export const normalizeEventPayload = (input: unknown): EventLike | undefined => {
  if (!isRecord(input)) {
    return undefined;
  }

  return {
    ...input,
    properties: normalizeEventProperties(input.properties),
  };
};
