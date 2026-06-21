import { describe, expect, it, vi } from 'vitest';

import { MONTH_SECONDS, WEEK_SECONDS } from '../src/domain/format.ts';
import { detailTextLine, headingLine, paceLine, renderQuotaLine, windowLine } from '../src/domain/lines.ts';
import type { OpenAIResetCreditsResult } from '../src/domain/types.ts';
import { formatCopilotLines } from '../src/infrastructure/providers/copilot.ts';
import { formatGoLines } from '../src/infrastructure/providers/go.ts';
import { formatOpenAILines } from '../src/infrastructure/providers/openai.ts';
import { formatOpenRouterLines } from '../src/infrastructure/providers/openrouter.ts';

const fetchedAtMs = 1_700_000_000_000;

describe('formatGoLines', () => {
  it('returns a detail line when no dashboard windows exist', () => {
    expect(
      formatGoLines(
        {
          rolling: null,
          weekly: null,
          monthly: null,
        },
        'remaining',
        fetchedAtMs,
      ),
    ).toEqual([detailTextLine('No windows')]);
  });

  it('formats all dashboard windows and the monthly pace line', () => {
    expect(
      formatGoLines(
        {
          rolling: { used: 0, remaining: 100, resetInSec: 300 },
          weekly: { used: 0, remaining: 100, resetInSec: 600 },
          monthly: { used: 0, remaining: 100, resetInSec: 900 },
        },
        'used',
        fetchedAtMs,
      ),
    ).toEqual([
      windowLine('5h', '0%', 300, fetchedAtMs, 'neutral', 0),
      windowLine('Wk', '0%', 600, fetchedAtMs, 'neutral', 0),
      windowLine('Mo', '0%', 900, fetchedAtMs, 'neutral', 0),
      paceLine({ usedPct: 0, resetSec: 900 }, MONTH_SECONDS, fetchedAtMs),
    ]);
  });

  it('formats a single monthly window in remaining mode', () => {
    expect(
      formatGoLines(
        {
          rolling: null,
          weekly: null,
          monthly: { used: 25, remaining: 75, resetInSec: 3600 },
        },
        'remaining',
        fetchedAtMs,
      ),
    ).toEqual([
      windowLine('Mo', '75%', 3600, fetchedAtMs, 'neutral', 25),
      paceLine({ usedPct: 25, resetSec: 3600 }, MONTH_SECONDS, fetchedAtMs),
    ]);
  });
});

describe('formatCopilotLines', () => {
  it('formats the monthly window and pace line when reset data exists', () => {
    expect(
      formatCopilotLines(
        {
          text: '70/100',
          used: 30,
          remaining: 70,
          total: 100,
          pctRemaining: 70,
          resetSec: 3600,
        },
        'remaining',
        fetchedAtMs,
      ),
    ).toEqual([
      windowLine('Mo', '70 pts', 3600, fetchedAtMs, 'neutral', 30),
      paceLine({ usedPct: 30, resetSec: 3600 }, MONTH_SECONDS, fetchedAtMs),
    ]);
  });

  it('omits the pace line when pctRemaining is unavailable', () => {
    expect(
      formatCopilotLines(
        {
          text: '15/100',
          remaining: 15,
          total: 100,
          resetSec: 7200,
        },
        'remaining',
        fetchedAtMs,
      ),
    ).toEqual([windowLine('Mo', '15 pts', 7200, fetchedAtMs, 'neutral', undefined)]);
  });

  it('falls back to a detail line when reset data is missing', () => {
    expect(
      formatCopilotLines(
        {
          text: '5/100',
          remaining: 5,
          total: 100,
        },
        'remaining',
        fetchedAtMs,
      ),
    ).toEqual([detailTextLine('Monthly 5 pts')]);
  });

  it('preserves unlimited text when no numeric quota is available', () => {
    expect(
      formatCopilotLines(
        {
          text: 'Unlimited',
          unlimited: true,
        },
        'used',
        fetchedAtMs,
      ),
    ).toEqual([detailTextLine('Monthly Unlimited')]);
  });
});

describe('formatOpenRouterLines', () => {
  it('formats remaining credits using the provider text', () => {
    expect(
      formatOpenRouterLines(
        {
          text: '$7.50',
          remaining: 7.5,
          total: 10,
          usage: 2.5,
        },
        'remaining',
      ),
    ).toEqual([detailTextLine('Credits $7.50')]);
  });

  it('formats used credits when the total is known', () => {
    expect(
      formatOpenRouterLines(
        {
          text: '$7.50',
          remaining: 7.5,
          total: 10,
          usage: 2.5,
        },
        'used',
      ),
    ).toEqual([detailTextLine('Credits $2.50/$10.00')]);
  });

  it('falls back to the raw provider text when there is no total', () => {
    expect(
      formatOpenRouterLines(
        {
          text: '$1.2345 used (no limit)',
          usage: 1.2345,
        },
        'used',
      ),
    ).toEqual([detailTextLine('Credits $1.2345 used (no limit)')]);
  });
});

describe('formatOpenAILines', () => {
  it('returns a detail line when the payload contains no windows', () => {
    expect(formatOpenAILines({}, 'remaining', fetchedAtMs)).toEqual([detailTextLine('No windows')]);
  });

  it('formats primary OpenAI windows, weekly pace, and credits', () => {
    expect(
      formatOpenAILines(
        {
          hourly: { usedPct: 20, resetSec: 300 },
          weekly: { usedPct: 30, resetSec: 600 },
          codeReview: { usedPct: 40, resetSec: 900 },
          credits: '$5.00',
        },
        'used',
        fetchedAtMs,
      ),
    ).toEqual([
      headingLine('OpenAI'),
      windowLine('5h', '20%', 300, fetchedAtMs, 'neutral', 20),
      windowLine('Wk', '30%', 600, fetchedAtMs, 'neutral', 30),
      paceLine({ usedPct: 30, resetSec: 600 }, WEEK_SECONDS, fetchedAtMs),
      windowLine('Code', '40%', 900, fetchedAtMs, 'neutral', 40),
      detailTextLine('Credits $5.00'),
    ]);
  });

  it('formats spark rate limits under a dedicated heading', () => {
    expect(
      formatOpenAILines(
        {
          additionalRateLimits: [
            {
              label: 'Codex Spark',
              limitName: 'codex-spark',
              primary: { usedPct: 10, resetSec: 100 },
              secondary: { usedPct: 20, resetSec: 200, limitWindowSec: 1234 },
            },
          ],
        },
        'remaining',
        fetchedAtMs,
      ),
    ).toEqual([
      headingLine('Spark'),
      windowLine('5h', '90%', 100, fetchedAtMs, 'neutral', 10),
      windowLine('Wk', '80%', 200, fetchedAtMs, 'neutral', 20),
      paceLine({ usedPct: 20, resetSec: 200 }, 1234, fetchedAtMs),
    ]);
  });

  it('formats additional non-spark limits with provider-owned labels', () => {
    expect(
      formatOpenAILines(
        {
          additionalRateLimits: [
            {
              label: 'Vision',
              allowed: false,
              primary: { usedPct: 55, resetSec: 111 },
              secondary: { usedPct: 66, resetSec: 222 },
            },
            {
              label: 'Audio',
              limitReached: true,
              secondary: { usedPct: 70, resetSec: 333 },
            },
          ],
        },
        'used',
        fetchedAtMs,
      ),
    ).toEqual([
      headingLine('OpenAI'),
      windowLine('blocked · Vision', '55%', 111, fetchedAtMs, 'error', 55),
      windowLine('blocked · Vision 2nd', '66%', 222, fetchedAtMs, 'error', 66),
      windowLine('limit reached · Audio 2nd', '70%', 333, fetchedAtMs, 'error', 70),
    ]);
  });

  it('compacts long additional OpenAI labels before rendering them in the sidebar', () => {
    const lines = formatOpenAILines(
      {
        additionalRateLimits: [
          {
            label: 'Extraordinarily Long Additional Rate Limit Name',
            allowed: false,
            primary: { usedPct: 55, resetSec: 111 },
          },
        ],
      },
      'used',
      fetchedAtMs,
    );

    expect(lines).toEqual([
      headingLine('OpenAI'),
      windowLine('blocked · Extraordina…', '55%', 111, fetchedAtMs, 'error', 55),
    ]);
  });

  it('appends reset credits lines after the credits line when available', () => {
    const dateTimeFormatSpy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function () {
      return {
        format: (date: Date) => {
          return date.getUTCMonth() === 6 ? 'Jul 17' : 'Jun 17';
        },
      } as Intl.DateTimeFormat;
    } as typeof Intl.DateTimeFormat);

    const resetCredits: OpenAIResetCreditsResult = {
      state: 'available',
      availableCount: 1,
      credits: [
        {
          grantedAtIso: '2026-06-17T17:38:38Z',
          expiresAtIso: '2026-07-17T17:38:38Z',
          status: 'available',
        },
      ],
      nextExpiresAtMs: Date.parse('2026-07-17T17:38:38Z'),
    };

    const lines = formatOpenAILines(
      {
        weekly: { usedPct: 30, resetSec: 600 },
        credits: '$5.00',
        resetCredits,
      },
      'remaining',
      fetchedAtMs,
    );

    expect(dateTimeFormatSpy).toHaveBeenCalled();
    expect(lines).toEqual([
      headingLine('OpenAI'),
      windowLine('Wk', '70%', 600, fetchedAtMs, 'neutral', 30),
      paceLine({ usedPct: 30, resetSec: 600 }, WEEK_SECONDS, fetchedAtMs),
      detailTextLine('Credits $5.00'),
      detailTextLine('Reset · 1 available · Jul 17'),
      detailTextLine('Granted Jun 17'),
    ]);
  });

  it('shows none available state for reset credits with zero count', () => {
    const resetCredits: OpenAIResetCreditsResult = {
      state: 'none-available',
      availableCount: 0,
      credits: [],
    };

    const lines = formatOpenAILines(
      {
        weekly: { usedPct: 30, resetSec: 600 },
        resetCredits,
      },
      'remaining',
      fetchedAtMs,
    );

    expect(lines).toContainEqual(detailTextLine('Reset · none'));
  });

  it('shows unavailable state for reset credits that failed to load', () => {
    const resetCredits: OpenAIResetCreditsResult = {
      state: 'unavailable',
      availableCount: 0,
      credits: [],
      errorMessage: 'OpenAI reset credits HTTP 403',
    };

    const lines = formatOpenAILines(
      {
        weekly: { usedPct: 30, resetSec: 600 },
        resetCredits,
      },
      'remaining',
      fetchedAtMs,
    );

    expect(lines).toContainEqual(detailTextLine('Reset · unavailable', 'error'));
    expect(lines.some((line) => line.kind === 'detail' && line.text.includes('HTTP 403'))).toBe(false);
  });

  it('uses plural form for multiple reset credits', () => {
    const resetCredits: OpenAIResetCreditsResult = {
      state: 'available',
      availableCount: 3,
      credits: [],
    };

    const lines = formatOpenAILines(
      {
        weekly: { usedPct: 30, resetSec: 600 },
        resetCredits,
      },
      'remaining',
      fetchedAtMs,
    );

    expect(lines).toContainEqual(detailTextLine('Reset · 3 available'));
  });
});

describe('renderQuotaLine window format', () => {
  it('renders a window line with label, value, and reset duration', () => {
    const line = windowLine('Wk', '5%', 90, fetchedAtMs);
    expect(renderQuotaLine(line, fetchedAtMs)).toBe('  Wk 5% · 1m30s');
  });

  it('renders a window line with a long label without padding', () => {
    const line = windowLine('Vision', '55%', 111, fetchedAtMs, 'error');
    expect(renderQuotaLine(line, fetchedAtMs)).toBe('  Vision 55% · 1m51s');
  });

  it('renders a window line with 100% usage', () => {
    const line = windowLine('Mo', '100%', 3600, fetchedAtMs);
    expect(renderQuotaLine(line, fetchedAtMs)).toBe('  Mo 100% · 1h0m0s');
  });

  it('renders a window line with zero reset time', () => {
    const line = windowLine('5h', '95%', 0, fetchedAtMs);
    expect(renderQuotaLine(line, fetchedAtMs)).toBe('  5h 95% · 0s');
  });
});

describe('renderQuotaLine pace format', () => {
  it('renders under-pace info with checkmark', () => {
    const line = paceLine({ usedPct: 5, resetSec: 90 }, 100, fetchedAtMs);
    expect(renderQuotaLine(line, fetchedAtMs)).toBe('    ✓ 5% under');
  });

  it('renders over-pace info with warning and recovery projection', () => {
    const line = paceLine({ usedPct: 15, resetSec: 90 }, 100, fetchedAtMs);
    expect(renderQuotaLine(line, fetchedAtMs)).toBe('    ⚠ 5% over · ~5s');
  });

  it('renders over-pace with recovery for a weekly window', () => {
    const resetSec = 4 * 24 * 60 * 60;
    const line = paceLine({ usedPct: 50, resetSec }, WEEK_SECONDS, fetchedAtMs);
    const rendered = renderQuotaLine(line, fetchedAtMs);
    expect(rendered).toContain('⚠');
    expect(rendered).toContain('7.14%');
    expect(rendered).toContain('~12h');
  });

  it('renders at-pace as below with zero delta', () => {
    const line = paceLine({ usedPct: 10, resetSec: 90 }, 100, fetchedAtMs);
    expect(renderQuotaLine(line, fetchedAtMs)).toBe('    ✓ 0% under');
  });
});
