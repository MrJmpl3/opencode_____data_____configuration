import { describe, expect, it } from 'vitest';

import {
  computePaceStatus,
  computeRecoverySeconds,
  formatCountQuota,
  formatCreditQuota,
  formatPercentQuota,
  formatResponsibleUsagePace,
  formatResponsibleWeeklyUsage,
  formatResetCreditDate,
  formatUsedPercentQuota,
  WEEK_SECONDS,
} from '../src/domain/format.ts';

describe('formatPercentQuota', () => {
  it('formats used and remaining percentages according to the display mode', () => {
    expect(formatPercentQuota(33.6, 66.4, 'used')).toBe('34%');
    expect(formatPercentQuota(33.6, 66.4, 'remaining')).toBe('66%');
  });
});

describe('formatUsedPercentQuota', () => {
  it('clamps values below zero', () => {
    expect(formatUsedPercentQuota(-10, 'used')).toBe('0%');
  });

  it('clamps values above one hundred', () => {
    expect(formatUsedPercentQuota(120, 'remaining')).toBe('0%');
  });
});

describe('formatResponsibleUsagePace', () => {
  it('reports usage below the responsible pace', () => {
    expect(formatResponsibleUsagePace({ usedPct: 5, resetSec: 90 }, 100)).toBe('✓ 5% under');
  });

  it('reports usage exactly at the responsible pace', () => {
    expect(formatResponsibleUsagePace({ usedPct: 10, resetSec: 90 }, 100)).toBe('✓ 0% under');
  });

  it('reports usage above the responsible pace', () => {
    expect(formatResponsibleUsagePace({ usedPct: 15, resetSec: 90 }, 100)).toBe('⚠ 5% over');
  });
});

describe('formatResponsibleWeeklyUsage', () => {
  it('uses the weekly window for responsible pace calculations', () => {
    expect(formatResponsibleWeeklyUsage({ usedPct: 50, resetSec: WEEK_SECONDS / 2 })).toBe('✓ 0% under');
  });
});

describe('formatCountQuota', () => {
  it('derives missing values when the total is known', () => {
    expect(formatCountQuota({ text: '70/100', used: 30, total: 100 }, 'remaining')).toBe('70 pts');
    expect(formatCountQuota({ text: '70/100', remaining: 70, total: 100 }, 'used')).toBe('30 pts');
  });

  it('falls back to the provider text when no numeric value can be computed', () => {
    expect(formatCountQuota({ text: 'Unlimited' }, 'used')).toBe('Unlimited');
  });

  it('clamps negative derived values to zero', () => {
    expect(formatCountQuota({ text: '-2/10', used: 12, total: 10 }, 'remaining')).toBe('0 pts');
  });
});

describe('formatCreditQuota', () => {
  it('formats used credits when the total is known', () => {
    expect(formatCreditQuota({ text: '$7.50', remaining: 7.5, total: 10 }, 'used')).toBe('$2.50/$10.00');
  });

  it('keeps the provider text for remaining credits', () => {
    expect(formatCreditQuota({ text: '$7.50', usage: 2.5, remaining: 7.5, total: 10 }, 'remaining')).toBe('$7.50');
  });

  it('falls back to the provider text when no total exists', () => {
    expect(formatCreditQuota({ text: '$1.2345 used (no limit)', usage: 1.2345 }, 'used')).toBe(
      '$1.2345 used (no limit)',
    );
  });
});

describe('computeRecoverySeconds', () => {
  it('returns undefined when usage is below the responsible pace', () => {
    expect(computeRecoverySeconds({ usedPct: 5, resetSec: 90 }, 100)).toBeUndefined();
  });

  it('returns undefined when usage is exactly at the responsible pace', () => {
    expect(computeRecoverySeconds({ usedPct: 10, resetSec: 90 }, 100)).toBeUndefined();
  });

  it('returns the seconds needed to recover when over the responsible pace', () => {
    expect(computeRecoverySeconds({ usedPct: 15, resetSec: 90 }, 100)).toBe(5);
  });

  it('returns undefined when the window will reset before the responsible pace can catch up', () => {
    expect(computeRecoverySeconds({ usedPct: 95, resetSec: 1 }, 100)).toBeUndefined();
  });

  it('computes recovery for a weekly window with a small overage', () => {
    const resetSec = 6 * 24 * 60 * 60 + 18 * 60 * 60;
    expect(computeRecoverySeconds({ usedPct: 4, resetSec }, WEEK_SECONDS)).toBe(2592);
  });

  it('computes recovery for a weekly window with a significant overage', () => {
    const resetSec = 4 * 24 * 60 * 60;
    expect(computeRecoverySeconds({ usedPct: 50, resetSec }, WEEK_SECONDS)).toBe(43_200);
  });

  it('clamps usedPct to 100 before computing', () => {
    expect(computeRecoverySeconds({ usedPct: 120, resetSec: 90 }, 100)).toBe(90);
  });
});

describe('computePaceStatus', () => {
  it('reports below pace with negative delta', () => {
    const status = computePaceStatus({ usedPct: 5, resetSec: 90 }, 100);
    expect(status.isOverPace).toBe(false);
    expect(status.deltaPercent).toBe(-5);
    expect(status.elapsedSeconds).toBe(10);
    expect(status.responsibleUsedPercent).toBe(10);
  });

  it('reports at pace with zero delta', () => {
    const status = computePaceStatus({ usedPct: 10, resetSec: 90 }, 100);
    expect(status.isOverPace).toBe(false);
    expect(status.deltaPercent).toBe(0);
  });

  it('reports over pace with positive delta', () => {
    const status = computePaceStatus({ usedPct: 15, resetSec: 90 }, 100);
    expect(status.isOverPace).toBe(true);
    expect(status.deltaPercent).toBe(5);
    expect(status.usedPct).toBe(15);
    expect(status.totalSeconds).toBe(100);
  });

  it('clamps usedPct to [0, 100]', () => {
    const overClamped = computePaceStatus({ usedPct: 120, resetSec: 90 }, 100);
    expect(overClamped.usedPct).toBe(100);

    const underClamped = computePaceStatus({ usedPct: -10, resetSec: 90 }, 100);
    expect(underClamped.usedPct).toBe(0);
  });
});

describe('formatResetCreditDate', () => {
  const fixedDate = Date.UTC(2026, 6, 17, 17, 38, 38);

  it('formats a date with a fixed locale and timezone for deterministic output', () => {
    const formatted = formatResetCreditDate(fixedDate, { locale: 'en-US', timeZone: 'UTC' });
    expect(formatted).toBe('Jul 17, 2026, 05:38 PM UTC');
  });

  it('formats a date without options using the system defaults', () => {
    const formatted = formatResetCreditDate(fixedDate, { locale: 'en-US', timeZone: 'UTC' });
    expect(formatted).toContain('Jul 17, 2026');
    expect(formatted).toContain('05:38 PM');
  });

  it('formats a different date correctly', () => {
    const otherDate = Date.UTC(2026, 5, 17, 12, 0, 0);
    const formatted = formatResetCreditDate(otherDate, { locale: 'en-US', timeZone: 'UTC' });
    expect(formatted).toBe('Jun 17, 2026, 12:00 PM UTC');
  });
});
