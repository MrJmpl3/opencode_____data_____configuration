import { isRecord, type UnknownRecord } from './coercion.js';

/** E4: delegates to Object.prototype.hasOwnProperty.call */
export const hasOwn = (value: UnknownRecord, key: string): boolean =>
  isRecord(value) ? Object.prototype.hasOwnProperty.call(value, key) : false;

/** E1: returns event.properties if record, else event, else {} */
export const eventProperties = (event: unknown): UnknownRecord => {
  if (!isRecord(event)) return {};

  return isRecord(event.properties) ? event.properties : event;
};

/** E2: reads properties.sessionID (capital D) */
export const eventSessionId = (event: unknown, fallback = ''): string => {
  const properties = eventProperties(event);
  const sessionId = properties.sessionID;

  return typeof sessionId === 'string' ? sessionId : fallback;
};

/** E3: reads slotInput.session_id */
export const slotSessionId = (slotInput: unknown, fallback = ''): string => {
  if (!isRecord(slotInput)) return fallback;

  const sessionId = slotInput.session_id;

  return typeof sessionId === 'string' ? sessionId : fallback;
};
