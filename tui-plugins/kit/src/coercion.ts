export type UnknownRecord = Record<string, unknown>;

/** C1: returns true for any non-null object, including arrays */
export const isRecord = (v: unknown): v is UnknownRecord =>
  typeof v === 'object' && v !== null;

/** C2: returns true only for non-null plain objects (array-EXCLUDING) */
export const isPlainObject = (v: unknown): v is UnknownRecord =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** C3: returns original string for non-empty strings, else undefined */
export const asString = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim().length > 0 ? v : undefined;

/** C4: returns lowercased trimmed string for non-empty strings, else undefined */
export const normalizedString = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim().length > 0 ? v.trim().toLowerCase() : undefined;

/** C5: returns a finite number or undefined */
export const toFiniteNumber = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim().length > 0) {
    const parsed = Number(v);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
};

/** C6: returns integer >= 0 or undefined */
export const toNonNegativeInteger = (v: unknown): number | undefined => {
  const parsed = toFiniteNumber(v);
  if (parsed === undefined) return undefined;
  return Math.max(0, Math.floor(parsed));
};

/** C7: returns epoch ms or 0; input may be string | undefined */
export const timestampMs = (input: string | undefined): number => {
  if (!input) return 0;
  const parsed = Date.parse(input);
  return Number.isNaN(parsed) ? 0 : parsed;
};

/** C8: returns input if parseable, else fallback */
export const safeTimestamp = (input: unknown, fallback: string): string => {
  if (typeof input !== 'string') return fallback;
  return Number.isNaN(Date.parse(input)) ? fallback : input;
};

/** C9: returns ISO string or undefined */
export const timestampFromUnknown = (v: unknown): string | undefined => {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    const millis = v < 10_000_000_000 ? v * 1000 : v;
    const parsed = new Date(millis);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }

  if (typeof v === 'string' && v.trim().length > 0) {
    const parsed = Date.parse(v);
    return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
  }

  return undefined;
};
