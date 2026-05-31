export type UnknownRecord = Record<string, unknown>;

export const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null;

export const detailLine = (text: string): string => `  ${text}`;

export const slotSessionId = (slotInput: unknown, fallback = ''): string => {
  if (!isRecord(slotInput)) return fallback;

  const sessionId = slotInput.session_id;

  return typeof sessionId === 'string' ? sessionId : fallback;
};
