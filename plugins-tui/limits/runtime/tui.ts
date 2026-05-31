export type UnknownRecord = Record<string, unknown>;

export const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null;

export const formatCompactNumber = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}K`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;

  return String(n);
};

export const detailLine = (text: string): string => `  ${text}`;

export const eventProperties = (event: unknown): UnknownRecord => {
  if (!isRecord(event)) return {};

  return isRecord(event.properties) ? event.properties : event;
};

export const eventSessionId = (event: unknown, fallback = ''): string => {
  const properties = eventProperties(event);
  const sessionId = properties.sessionID;

  return typeof sessionId === 'string' ? sessionId : fallback;
};

export const slotSessionId = (slotInput: unknown, fallback = ''): string => {
  if (!isRecord(slotInput)) return fallback;

  const sessionId = slotInput.session_id;

  return typeof sessionId === 'string' ? sessionId : fallback;
};
