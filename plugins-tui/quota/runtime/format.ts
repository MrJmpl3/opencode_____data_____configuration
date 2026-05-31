import type { QuotaDisplayMode } from './options.js';

export const WEEK_SECONDS = 7 * 24 * 60 * 60;

const parseBackoffDelayMs = (message: string, pattern: RegExp): number => {
  const match = message.match(pattern);
  if (!match) return 0;
  const rawValue = match[1].trim();
  const numericValue = rawValue.match(/^\d+(?:\.\d+)?/)?.[0];
  const seconds = numericValue ? Number(numericValue) : Number.NaN;
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;

  const retryAtMs = Date.parse(rawValue);
  if (!Number.isNaN(retryAtMs)) return Math.max(0, retryAtMs - Date.now());

  return 0;
};

const parseBackoffResetMs = (message: string, pattern: RegExp): number => {
  const match = message.match(pattern);
  if (!match) return 0;
  const rawValue = match[1].trim();
  const numericValue = rawValue.match(/^\d+(?:\.\d+)?/)?.[0];
  const resetValue = numericValue ? Number(numericValue) : Number.NaN;
  if (Number.isFinite(resetValue) && resetValue > 0) {
    const resetAtMs = resetValue > 1_000_000_000 ? resetValue * 1000 : Date.now() + resetValue * 1000;
    return Math.max(0, resetAtMs - Date.now());
  }

  const retryAtMs = Date.parse(rawValue);
  if (!Number.isNaN(retryAtMs)) return Math.max(0, retryAtMs - Date.now());

  return 0;
};

export const isQuotaRateLimitError = (message: string): boolean => {
  return /\b(429|403)\b|rate.?limit|too many requests|temporar(?:y|ily)|secondary rate/i.test(message);
};

export const retryAfterMsFromMessage = (message: string): number => {
  const retryAfterMs = parseBackoffDelayMs(message, /retry[- ]after[:=]?\s*([^;\n]+)/i);
  if (retryAfterMs > 0) return retryAfterMs;

  return parseBackoffResetMs(message, /rate[- ]limit[- ]reset[:=]?\s*([^;\n]+)/i);
};

export const formatPercentQuota = (used: number, remaining: number, displayMode: QuotaDisplayMode): string => {
  if (displayMode === 'used') return `${used.toFixed(0)}%`;
  return `${remaining.toFixed(0)}%`;
};

export const formatUsedPercentQuota = (usedPct: number, displayMode: QuotaDisplayMode): string => {
  const used = Math.max(0, Math.min(100, usedPct));
  return formatPercentQuota(used, Math.max(0, 100 - used), displayMode);
};

export const formatResponsibleUsagePace = (
  window: {
    usedPct: number;
    resetSec: number;
  },
  windowSeconds: number,
): string => {
  const totalSec = Math.max(1, windowSeconds);
  const usedPct = Math.max(0, Math.min(100, window.usedPct));
  const remainingSec = Math.max(0, Math.min(totalSec, window.resetSec));
  const elapsedSec = totalSec - remainingSec;
  const responsibleUsedPct = (elapsedSec / totalSec) * 100;
  const deltaPct = usedPct - responsibleUsedPct;
  const absDelta = Math.abs(deltaPct).toFixed(2);

  if (deltaPct <= 0) {
    return `✓ ok · ${absDelta}% below`;
  }

  return `⚠ high · ${absDelta}% over`;
};

export const formatResponsibleWeeklyUsage = (window: { usedPct: number; resetSec: number }): string =>
  formatResponsibleUsagePace(window, WEEK_SECONDS);

export const formatCountQuota = (
  data: { text: string; used?: number; remaining?: number; total?: number },
  displayMode: QuotaDisplayMode,
): string => {
  const { used, remaining, total } = data;
  const hasTotal = typeof total === 'number' && Number.isFinite(total) && total > 0;

  const value =
    displayMode === 'used'
      ? (used ?? (hasTotal && typeof remaining === 'number' ? total - remaining : undefined))
      : (remaining ?? (hasTotal && typeof used === 'number' ? total - used : undefined));

  if (typeof value !== 'number' || !Number.isFinite(value)) return data.text;
  return `${Math.max(0, value).toFixed(0)} pts`;
};

export const formatCreditQuota = (
  data: { text: string; usage?: number; remaining?: number; total?: number },
  displayMode: QuotaDisplayMode,
): string => {
  const { usage, remaining, total } = data;
  if (typeof total !== 'number' || total <= 0) return data.text;

  const value =
    displayMode === 'used'
      ? (usage ?? (typeof remaining === 'number' ? total - remaining : undefined))
      : (remaining ?? (typeof usage === 'number' ? total - usage : undefined));

  if (typeof value !== 'number' || !Number.isFinite(value)) return data.text;
  if (displayMode === 'remaining') return data.text;
  return `$${Math.max(0, value).toFixed(2)}/$${total.toFixed(2)}`;
};

export const formatOpenAIRateLimitStatus = (limit: {
  allowed?: boolean;
  limitReached?: boolean;
}): string | undefined => {
  if (limit.limitReached) return 'limit reached';
  if (limit.allowed === false) return 'blocked';
  if (limit.allowed === true) return 'available';
  return undefined;
};

export const isOpenAISparkRateLimit = (limit: {
  label: string;
  limitName?: string;
  meteredFeature?: string;
}): boolean => {
  const haystack = [limit.label, limit.limitName, limit.meteredFeature]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLowerCase();
  return haystack.includes('spark') || haystack.includes('codex');
};
