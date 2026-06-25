import { describe, expect, it } from 'vitest';
import {
  finiteNumber,
  formatCompactNumber,
  detailLine,
  formatPercentRatio,
} from '../src/format.js';

describe('finiteNumber (F1)', () => {
  it('returns the value if finite', () => {
    expect(finiteNumber(42)).toBe(42);
    expect(finiteNumber(0)).toBe(0);
    expect(finiteNumber(-3.14)).toBe(-3.14);
  });

  it('returns 0 for Infinity', () => {
    expect(finiteNumber(Infinity)).toBe(0);
    expect(finiteNumber(-Infinity)).toBe(0);
  });

  it('returns 0 for NaN', () => {
    expect(finiteNumber(NaN)).toBe(0);
  });

  it('returns 0 for non-numbers', () => {
    expect(finiteNumber('42')).toBe(0);
    expect(finiteNumber(null)).toBe(0);
    expect(finiteNumber(undefined)).toBe(0);
    expect(finiteNumber('x')).toBe(0);
  });
});

describe('formatCompactNumber (F2: no locale param)', () => {
  it('formats with compact tiers', () => {
    expect(formatCompactNumber(1_500)).toBe('1.5K');
    expect(formatCompactNumber(10_500)).toBe('11K');
    expect(formatCompactNumber(2_000_000)).toBe('2.0M');
  });

  it('handles thousands exactly', () => {
    expect(formatCompactNumber(1_000)).toBe('1.0K');
    expect(formatCompactNumber(9_999)).toBe('10.0K'); // toFixed(1) rounds up before Math.round threshold
  });

  it('handles sub-thousand as plain string', () => {
    expect(formatCompactNumber(42)).toBe('42');
    expect(formatCompactNumber(0)).toBe('0');
  });

  it('handles millions boundary', () => {
    expect(formatCompactNumber(999_999)).toBe('1000K');
    expect(formatCompactNumber(1_000_000)).toBe('1.0M');
  });
});

describe('detailLine (F3)', () => {
  it('prepends two spaces', () => {
    expect(detailLine('label')).toBe('  label');
  });

  it('works with empty string', () => {
    expect(detailLine('')).toBe('  ');
  });
});

describe('formatPercentRatio (F4)', () => {
  it('converts ratio to integer percent', () => {
    expect(formatPercentRatio(0.25)).toBe('25%');
    expect(formatPercentRatio(0)).toBe('0%');
    expect(formatPercentRatio(1)).toBe('100%');
  });

  it('clamps to [0, 1]', () => {
    expect(formatPercentRatio(1.5)).toBe('100%');
    expect(formatPercentRatio(-0.5)).toBe('0%');
  });

  it('rounds to nearest integer percent', () => {
    expect(formatPercentRatio(0.333)).toBe(`33%`);
    expect(formatPercentRatio(0.666)).toBe(`67%`);
  });
});
