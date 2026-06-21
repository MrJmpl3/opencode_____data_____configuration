import type { OpenAIAdditionalRateLimit, QuotaDisplayMode, QuotaLineTone } from './types.ts';

export const WEEK_SECONDS = 7 * 24 * 60 * 60;
export const MONTH_SECONDS = 30 * 24 * 60 * 60;

export const formatPercentQuota = (used: number, remaining: number, displayMode: QuotaDisplayMode): string => {
  if (displayMode === 'used') return `${used.toFixed(0)}%`;
  return `${remaining.toFixed(0)}%`;
};

export const formatUsedPercentQuota = (usedPct: number, displayMode: QuotaDisplayMode): string => {
  const used = Math.max(0, Math.min(100, usedPct));
  return formatPercentQuota(used, Math.max(0, 100 - used), displayMode);
};

const formatCompactPercent = (value: number): string => value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');

export interface PaceStatus {
  readonly usedPct: number;
  readonly elapsedSeconds: number;
  readonly totalSeconds: number;
  readonly responsibleUsedPercent: number;
  readonly deltaPercent: number;
  readonly isOverPace: boolean;
}

export const computePaceStatus = (window: { usedPct: number; resetSec: number }, windowSeconds: number): PaceStatus => {
  const totalSeconds = Math.max(1, windowSeconds);
  const usedPct = Math.max(0, Math.min(100, window.usedPct));
  const remainingSeconds = Math.max(0, Math.min(totalSeconds, window.resetSec));
  const elapsedSeconds = totalSeconds - remainingSeconds;
  const responsibleUsedPercent = (elapsedSeconds / totalSeconds) * 100;
  const deltaPercent = usedPct - responsibleUsedPercent;

  return {
    usedPct,
    elapsedSeconds,
    totalSeconds,
    responsibleUsedPercent,
    deltaPercent,
    isOverPace: deltaPercent > 0,
  };
};

const formatPaceStatusText = (status: PaceStatus): string => {
  const absoluteDelta = formatCompactPercent(Math.abs(status.deltaPercent));

  if (!status.isOverPace) {
    return `✓ ${absoluteDelta}% under`;
  }

  return `⚠ ${absoluteDelta}% over`;
};

export const formatResponsibleUsagePace = (
  window: {
    usedPct: number;
    resetSec: number;
  },
  windowSeconds: number,
): string => {
  const status = computePaceStatus(window, windowSeconds);
  return formatPaceStatusText(status);
};

export const formatResponsibleWeeklyUsage = (window: { usedPct: number; resetSec: number }): string =>
  formatResponsibleUsagePace(window, WEEK_SECONDS);

const recoverySecondsFromStatus = (status: PaceStatus): number | undefined => {
  if (!status.isOverPace) return undefined;

  const recoverySeconds = Math.ceil((status.usedPct * status.totalSeconds) / 100 - status.elapsedSeconds);

  if (recoverySeconds <= 0) return undefined;

  return recoverySeconds;
};

export const computeRecoverySeconds = (
  window: { usedPct: number; resetSec: number },
  windowSeconds: number,
): number | undefined => {
  const status = computePaceStatus(window, windowSeconds);
  return recoverySecondsFromStatus(status);
};

export const formatPaceLineText = (
  window: { usedPct: number; resetSec: number },
  windowSeconds: number,
): { paceText: string; recoverySeconds: number | undefined } => {
  const status = computePaceStatus(window, windowSeconds);
  return {
    paceText: formatPaceStatusText(status),
    recoverySeconds: recoverySecondsFromStatus(status),
  };
};

export interface FormatDateOptions {
  locale?: string;
  timeZone?: string;
}

export const formatResetCreditDate = (dateMs: number, options?: FormatDateOptions): string => {
  return new Intl.DateTimeFormat(options?.locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
    timeZone: options?.timeZone,
  }).format(new Date(dateMs));
};

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

export const formatOpenAIRateLimitTone = (limit: {
  allowed?: boolean;
  limitReached?: boolean;
}): QuotaLineTone | undefined => {
  if (limit.limitReached) return 'error';
  if (limit.allowed === false) return 'error';
  return undefined;
};

const compactText = (text: string, maxLength: number): string => {
  const normalizedText = text.trim().replace(/\s+/g, ' ') || 'Additional limit';
  if (normalizedText.length <= maxLength) return normalizedText;
  if (maxLength <= 1) return normalizedText.slice(0, maxLength);

  return `${normalizedText.slice(0, maxLength - 1).trimEnd()}…`;
};

export const formatOpenAIAdditionalRateLimitLabel = (
  limit: Pick<OpenAIAdditionalRateLimit, 'label' | 'allowed' | 'limitReached'>,
  suffix?: string,
): string => {
  const stateLabel = limit.limitReached ? 'limit reached' : limit.allowed === false ? 'blocked' : '';
  const compactLabel = compactText(limit.label, stateLabel ? 12 : 16);
  const label = stateLabel ? `${stateLabel} · ${compactLabel}` : compactLabel;

  if (!suffix) return label;

  return `${label} ${suffix}`;
};

export const isOpenAISparkRateLimit = (
  limit: Pick<OpenAIAdditionalRateLimit, 'label' | 'limitName' | 'meteredFeature'>,
): boolean => {
  const haystack = [limit.label, limit.limitName, limit.meteredFeature]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLowerCase();
  return haystack.includes('spark') || haystack.includes('codex');
};
