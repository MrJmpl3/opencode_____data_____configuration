import { describe, expect, it } from 'vitest';
import {
  isRecord,
  isPlainObject,
  asString,
  normalizedString,
  toFiniteNumber,
  toNonNegativeInteger,
  timestampMs,
  safeTimestamp,
  timestampFromUnknown,
} from '../src/coercion.js';

describe('isRecord (C1: array-ACCEPTING)', () => {
  it('returns true for plain objects', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it('returns true for arrays', () => {
    expect(isRecord([])).toBe(true);
    expect(isRecord([1, 2, 3])).toBe(true);
  });

  it('returns true for Date and other non-null objects', () => {
    expect(isRecord(new Date())).toBe(true);
  });

  it('returns false for null', () => {
    expect(isRecord(null)).toBe(false);
  });

  it('returns false for primitives', () => {
    expect(isRecord(42)).toBe(false);
    expect(isRecord('hello')).toBe(false);
    expect(isRecord(true)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord(Symbol('s'))).toBe(false);
  });
});

describe('isPlainObject (C2: array-EXCLUDING)', () => {
  it('returns true for plain objects', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
  });

  it('returns false for arrays', () => {
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject([1, 2, 3])).toBe(false);
  });

  it('returns false for null', () => {
    expect(isPlainObject(null)).toBe(false);
  });

  it('returns false for primitives', () => {
    expect(isPlainObject(42)).toBe(false);
    expect(isPlainObject('hello')).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
  });
});

describe('asString (C3: untrimmed, non-empty)', () => {
  it('returns the original string for non-empty strings', () => {
    expect(asString('  x  ')).toBe('  x  ');
    expect(asString('hello')).toBe('hello');
  });

  it('returns undefined for empty string', () => {
    expect(asString('')).toBeUndefined();
  });

  it('returns undefined for whitespace-only', () => {
    expect(asString('   ')).toBeUndefined();
  });

  it('returns undefined for non-strings', () => {
    expect(asString(null)).toBeUndefined();
    expect(asString(42)).toBeUndefined();
    expect(asString(undefined)).toBeUndefined();
    expect(asString(true)).toBeUndefined();
    expect(asString({})).toBeUndefined();
  });
});

describe('normalizedString (C4: lowercased trimmed)', () => {
  it('returns lowercased trimmed string', () => {
    expect(normalizedString('  ABC  ')).toBe('abc');
    expect(normalizedString('Hello')).toBe('hello');
    expect(normalizedString('  X  ')).toBe('x');
  });

  it('returns undefined for empty string', () => {
    expect(normalizedString('')).toBeUndefined();
  });

  it('returns undefined for whitespace-only', () => {
    expect(normalizedString('    ')).toBeUndefined();
  });

  it('returns undefined for non-strings', () => {
    expect(normalizedString(null)).toBeUndefined();
    expect(normalizedString(42)).toBeUndefined();
    expect(normalizedString(undefined)).toBeUndefined();
  });
});

describe('toFiniteNumber (C5)', () => {
  it('returns the number if finite', () => {
    expect(toFiniteNumber(42)).toBe(42);
    expect(toFiniteNumber(0)).toBe(0);
    expect(toFiniteNumber(-3.14)).toBe(-3.14);
  });

  it('parses numeric string', () => {
    expect(toFiniteNumber('3.14')).toBe(3.14);
    expect(toFiniteNumber('42')).toBe(42);
  });

  it('returns undefined for NaN', () => {
    expect(toFiniteNumber(NaN)).toBeUndefined();
  });

  it('returns undefined for Infinity', () => {
    expect(toFiniteNumber(Infinity)).toBeUndefined();
    expect(toFiniteNumber(-Infinity)).toBeUndefined();
  });

  it('returns undefined for non-numeric strings', () => {
    expect(toFiniteNumber('foo')).toBeUndefined();
    expect(toFiniteNumber('')).toBeUndefined();
  });

  it('returns undefined for non-numeric non-strings', () => {
    expect(toFiniteNumber(null)).toBeUndefined();
    expect(toFiniteNumber(undefined)).toBeUndefined();
    expect(toFiniteNumber(true)).toBeUndefined();
    expect(toFiniteNumber({})).toBeUndefined();
  });
});

describe('toNonNegativeInteger (C6)', () => {
  it('returns integer >= 0 for positive numbers', () => {
    expect(toNonNegativeInteger(5)).toBe(5);
    expect(toNonNegativeInteger(0)).toBe(0);
  });

  it('floors decimals to integer', () => {
    expect(toNonNegativeInteger(5.9)).toBe(5);
    expect(toNonNegativeInteger('5.9')).toBe(5);
  });

  it('returns 0 for negative numbers (Math.max(0, floor) — preserves existing behavior)', () => {
    expect(toNonNegativeInteger(-2)).toBe(0);
    expect(toNonNegativeInteger(-0.1)).toBe(0);
  });

  it('returns undefined for non-numeric input', () => {
    expect(toNonNegativeInteger('foo')).toBeUndefined();
    expect(toNonNegativeInteger(null)).toBeUndefined();
    expect(toNonNegativeInteger(undefined)).toBeUndefined();
    expect(toNonNegativeInteger(NaN)).toBeUndefined();
  });
});

describe('timestampMs (C7)', () => {
  it('returns epoch ms for valid ISO string', () => {
    const ms = timestampMs('2024-01-01T00:00:00.000Z');
    expect(ms).toBeGreaterThan(0);
    expect(typeof ms).toBe('number');
    expect(Number.isFinite(ms)).toBe(true);
  });

  it('returns 0 for undefined', () => {
    expect(timestampMs(undefined)).toBe(0);
  });

  it('returns 0 for empty string', () => {
    expect(timestampMs('')).toBe(0);
  });

  it('returns 0 for invalid string', () => {
    expect(timestampMs('not-a-date')).toBe(0);
  });
});

describe('safeTimestamp (C8)', () => {
  it('returns input if parseable', () => {
    const valid = '2024-01-01T00:00:00.000Z';
    expect(safeTimestamp(valid, 'fallback')).toBe(valid);
  });

  it('returns fallback if input is not a parseable string', () => {
    expect(safeTimestamp('not-a-date', 'fallback')).toBe('fallback');
    expect(safeTimestamp(42, 'fallback')).toBe('fallback');
    expect(safeTimestamp(null, 'fallback')).toBe('fallback');
  });
});

describe('timestampFromUnknown (C9)', () => {
  it('returns ISO string for a positive finite number (seconds)', () => {
    const result = timestampFromUnknown(1_700_000_000);
    expect(typeof result).toBe('string');
    expect(() => new Date(result!)).not.toThrow();
    expect(result?.endsWith('Z')).toBe(true);
  });

  it('returns ISO string for a positive finite number (milliseconds)', () => {
    const result = timestampFromUnknown(1_700_000_000_000);
    expect(typeof result).toBe('string');
    expect(() => new Date(result!)).not.toThrow();
  });

  it('returns ISO string for a valid date string', () => {
    const result = timestampFromUnknown('2024-01-01T00:00:00.000Z');
    expect(typeof result).toBe('string');
  });

  it('returns undefined for invalid string', () => {
    expect(timestampFromUnknown('bad')).toBeUndefined();
  });

  it('returns undefined for null', () => {
    expect(timestampFromUnknown(null)).toBeUndefined();
  });

  it('returns undefined for non-numeric, non-string values', () => {
    expect(timestampFromUnknown(true)).toBeUndefined();
    expect(timestampFromUnknown({})).toBeUndefined();
    expect(timestampFromUnknown(undefined)).toBeUndefined();
  });
});
