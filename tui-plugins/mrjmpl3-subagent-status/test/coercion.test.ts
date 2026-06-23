import { describe, expect, it } from 'vitest';

import { isRecord } from '../src/shared/coercion.ts';

describe('coercion', () => {
  it('rejects arrays when checking isRecord', () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord([1, 2, 3])).toBe(false);
    expect(isRecord({})).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord('string')).toBe(false);
    expect(isRecord(42)).toBe(false);
    expect(isRecord({ a: 1 })).toBe(true);
  });
});
