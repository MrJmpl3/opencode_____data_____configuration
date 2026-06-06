export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value : undefined;

export const normalizedString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim().toLowerCase() : undefined;

export const toFiniteNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
};

export const toNonNegativeInteger = (value: unknown): number | undefined => {
  const parsed = toFiniteNumber(value);
  if (parsed === undefined) return undefined;
  return Math.max(0, Math.floor(parsed));
};

export const safeTimestamp = (input: unknown, fallback: string): string => {
  if (typeof input !== 'string') return fallback;
  return Number.isNaN(Date.parse(input)) ? fallback : input;
};

export const timestampMs = (input: string | undefined): number => {
  if (!input) return 0;
  const parsed = Date.parse(input);
  return Number.isNaN(parsed) ? 0 : parsed;
};

export const timestampFromUnknown = (value: unknown): string | undefined => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const millis = value < 10_000_000_000 ? value * 1000 : value;
    const parsed = new Date(millis);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
  }

  return undefined;
};
