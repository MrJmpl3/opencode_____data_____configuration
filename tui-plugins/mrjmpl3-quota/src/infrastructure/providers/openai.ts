import type { QuotaLine } from '../../domain/lines.ts';
import type {
  OpenAIAdditionalRateLimit,
  OpenAIResetCredit,
  OpenAIResetCreditStatus,
  OpenAIResetCreditsResult,
  OpenAIResetCreditsState,
  OpenAIResult,
  OpenAIWindow,
  QuotaDisplayMode,
  QuotaLineTone,
} from '../../domain/types.ts';
import {
  formatOpenAIAdditionalRateLimitLabel,
  formatOpenAIRateLimitTone,
  formatUsedPercentQuota,
  isOpenAISparkRateLimit,
  WEEK_SECONDS,
} from '../../domain/format.ts';
import { detailTextLine, headingLine, paceLine, windowLine } from '../../domain/lines.ts';
import { OPENAI_RESET_CREDITS_URL, OPENAI_USAGE_URL } from './constants.ts';
import { readOauthAccessToken, readOpenAIAccountId } from './auth.ts';
import { fetchWithTimeout, httpErrorMessage, readJsonResponse } from './http.ts';
import { firstDefined, isRecord, readBooleanField, readNumericField, readStringField } from './shared.ts';

const readOpenAIToken = (): string | null => {
  return readOauthAccessToken(['openai', 'chatgpt', 'codex', 'opencode']);
};

const normalizeUsedPercent = (value: number): number => Math.max(0, Math.min(100, value));

const readWindowResetSeconds = (record: Record<string, unknown>): number | undefined => {
  const resetAfterSeconds = firstDefined(
    readNumericField(record, 'reset_after_seconds'),
    readNumericField(record, 'reset_after'),
    readNumericField(record, 'resetAfter'),
    readNumericField(record, 'reset_in_seconds'),
    readNumericField(record, 'resetInSec'),
  );
  if (resetAfterSeconds !== undefined) {
    return Math.max(0, Math.floor(resetAfterSeconds));
  }

  const resetAt = readStringField(record, 'reset_at') || readStringField(record, 'resetAt');
  if (resetAt) {
    const date = Date.parse(resetAt);
    if (!Number.isNaN(date)) {
      return Math.max(0, Math.floor((date - Date.now()) / 1000));
    }
  }

  const resetAtEpoch = readNumericField(record, 'reset_at');
  if (resetAtEpoch !== undefined) {
    const ms = resetAtEpoch > 1_000_000_000_000 ? resetAtEpoch : resetAtEpoch * 1000;
    return Math.max(0, Math.floor((ms - Date.now()) / 1000));
  }

  return undefined;
};

const findFirstString = (record: Record<string, unknown>, keys: readonly string[]): string | undefined => {
  for (const key of keys) {
    const found = readStringField(record, key);
    if (found) return found;
  }
  return undefined;
};

const cleanLimitLabel = (rawLabel: string): string => {
  const normalized = rawLabel.trim().replace(/\s+/g, ' ');
  if (normalized.toLowerCase().includes('codex-spark')) return 'Codex Spark';
  return normalized || 'Additional limit';
};

const parseOpenAIWindow = (value: unknown): OpenAIWindow | undefined => {
  if (!isRecord(value)) return undefined;
  const record = value;
  const usedPercentCandidate = firstDefined(
    readNumericField(record, 'used_percent'),
    readNumericField(record, 'used_pct'),
    readNumericField(record, 'usage_pct'),
    readNumericField(record, 'pct_used'),
  );

  const usedAmount = readNumericField(record, 'used');
  const remainingAmount = readNumericField(record, 'remaining');
  const limitAmount = firstDefined(
    readNumericField(record, 'limit'),
    readNumericField(record, 'total'),
    readNumericField(record, 'quota'),
  );
  const remainingPercent = firstDefined(
    readNumericField(record, 'remaining_percent'),
    readNumericField(record, 'remainingPct'),
    readNumericField(record, 'remaining_pct'),
  );

  let usedPct: number | undefined = usedPercentCandidate;

  if (usedPct === undefined && usedAmount !== undefined && limitAmount !== undefined && limitAmount > 0) {
    usedPct = (usedAmount / limitAmount) * 100;
  }

  if (usedPct === undefined && remainingAmount !== undefined && limitAmount !== undefined && limitAmount > 0) {
    usedPct = (1 - remainingAmount / limitAmount) * 100;
  }

  if (usedPct === undefined && remainingPercent !== undefined) {
    usedPct = 100 - remainingPercent;
  }

  if (usedPct === undefined || Number.isNaN(usedPct)) return undefined;

  const resetSec = readWindowResetSeconds(record);
  if (resetSec === undefined) return undefined;
  const limitWindowSec = firstDefined(
    readNumericField(record, 'limit_window_seconds'),
    readNumericField(record, 'limitWindowSeconds'),
    readNumericField(record, 'limitWindowSec'),
    readNumericField(record, 'window_seconds'),
  );

  return {
    usedPct: normalizeUsedPercent(usedPct),
    resetSec,
    limitWindowSec: limitWindowSec !== undefined ? Math.max(0, Math.floor(limitWindowSec)) : undefined,
  };
};

const firstWindow = (record: Record<string, unknown>): { primary?: OpenAIWindow; secondary?: OpenAIWindow } => {
  const primary =
    parseOpenAIWindow(record['primary_window']) ||
    parseOpenAIWindow(record['primary']) ||
    parseOpenAIWindow(record['window']) ||
    parseOpenAIWindow(record['window_primary']) ||
    undefined;

  const secondary =
    parseOpenAIWindow(record['secondary_window']) ||
    parseOpenAIWindow(record['secondary']) ||
    parseOpenAIWindow(record['window_secondary']) ||
    undefined;

  if (primary || secondary) {
    return { primary, secondary };
  }

  const directWindow = parseOpenAIWindow(record);
  return directWindow ? { primary: directWindow } : {};
};

const parseWindowFromAliases = (
  value: Record<string, unknown> | undefined,
  aliases: readonly string[],
): OpenAIWindow | undefined => {
  if (!value) return undefined;
  for (const alias of aliases) {
    const window = parseOpenAIWindow(value[alias]);
    if (window) return window;
  }
  return parseOpenAIWindow(value);
};

export const parseAdditionalRateLimits = (value: unknown): OpenAIAdditionalRateLimit[] => {
  if (!isRecord(value) && !Array.isArray(value)) return [];

  const parseEntry = (key: string, item: unknown): OpenAIAdditionalRateLimit | null => {
    if (!isRecord(item)) return null;
    const rateLimitRecord = isRecord(item.rate_limit) ? item.rate_limit : undefined;

    const label = cleanLimitLabel(
      findFirstString(item, [
        'limit_name',
        'limitName',
        'name',
        'metered_feature',
        'meteredFeature',
        'bucket',
        'id',
        'window_name',
      ]) || key,
    );

    const nestedWindows = rateLimitRecord ? firstWindow(rateLimitRecord) : {};
    const windows = nestedWindows.primary || nestedWindows.secondary ? nestedWindows : firstWindow(item);
    if (!windows.primary && !windows.secondary) return null;
    const stateRecord = rateLimitRecord ?? item;

    return {
      label,
      limitName: findFirstString(item, ['limit_name', 'limitName']),
      meteredFeature: findFirstString(item, ['metered_feature', 'meteredFeature']),
      allowed: readBooleanField(stateRecord, 'allowed'),
      limitReached: readBooleanField(stateRecord, 'limit_reached'),
      primary: windows.primary,
      secondary: windows.secondary,
    };
  };

  if (Array.isArray(value)) {
    return value
      .map((item, index) => parseEntry(`additional-${index}`, item))
      .filter((entry): entry is OpenAIAdditionalRateLimit => Boolean(entry));
  }

  if (!isRecord(value)) return [];

  return Object.entries(value)
    .map(([key, item]) => parseEntry(key, item))
    .filter((entry): entry is OpenAIAdditionalRateLimit => Boolean(entry));
};

const RESET_CREDIT_STATUS_VALUES: readonly OpenAIResetCreditStatus[] = [
  'available',
  'redeemed',
  'expired',
  'redeeming',
];

const parseResetCreditStatus = (value: unknown): OpenAIResetCreditStatus | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return RESET_CREDIT_STATUS_VALUES.includes(normalized as OpenAIResetCreditStatus)
    ? (normalized as OpenAIResetCreditStatus)
    : undefined;
};

const parseResetCreditEntry = (item: unknown): OpenAIResetCredit | null => {
  if (!isRecord(item)) return null;

  const grantedAtIso = readStringField(item, 'granted_at') ?? readStringField(item, 'grantedAt');
  const expiresAtIso = readStringField(item, 'expires_at') ?? readStringField(item, 'expiresAt');
  const status = parseResetCreditStatus(readStringField(item, 'status') ?? readStringField(item, 'state'));

  if (!grantedAtIso && !expiresAtIso && !status) return null;

  return { grantedAtIso, expiresAtIso, status };
};

export const parseResetCreditsPayload = (body: unknown, nowMs: number = Date.now()): OpenAIResetCreditsResult => {
  if (!isRecord(body)) {
    return {
      state: 'unavailable',
      availableCount: 0,
      credits: [],
      errorMessage: 'Invalid reset-credits payload',
    };
  }

  const availableCountRaw = readNumericField(body, 'available_count') ?? readNumericField(body, 'availableCount');
  const availableCount = typeof availableCountRaw === 'number' ? Math.max(0, Math.floor(availableCountRaw)) : 0;

  const creditsRaw = body.credits;
  const credits: OpenAIResetCredit[] = [];

  if (Array.isArray(creditsRaw)) {
    for (const item of creditsRaw) {
      const credit = parseResetCreditEntry(item);
      if (credit) credits.push(credit);
    }
  }

  const futureExpiryTimestamps = credits
    .map((credit) => (credit.expiresAtIso ? Date.parse(credit.expiresAtIso) : Number.NaN))
    .filter((ms) => !Number.isNaN(ms) && ms > nowMs)
    .sort((a, b) => a - b);

  const nextExpiresAtMs = futureExpiryTimestamps.length > 0 ? futureExpiryTimestamps[0] : undefined;

  const state: OpenAIResetCreditsState = availableCount > 0 ? 'available' : 'none-available';

  return { state, availableCount, credits, nextExpiresAtMs };
};

const buildOpenAIHeaders = (token: string): Record<string, string> => {
  const accountId = readOpenAIAccountId(token);
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'OpenCode-Quota-Toast/1.0',
  };
  if (accountId) headers['ChatGPT-Account-Id'] = accountId;
  return headers;
};

const fetchOpenAIResetCredits = async (headers: Record<string, string>, signal?: AbortSignal): Promise<OpenAIResetCreditsResult> => {
  try {
    const resetHeaders: Record<string, string> = {
      ...headers,
      'OpenAI-Beta': 'codex-1',
      originator: 'Codex Desktop',
    };

    const response = await fetchWithTimeout(OPENAI_RESET_CREDITS_URL, { headers: resetHeaders }, undefined, signal);
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return {
        state: 'unavailable',
        availableCount: 0,
        credits: [],
        errorMessage: httpErrorMessage('OpenAI reset credits', response, text),
      };
    }

    const bodyResult = await readJsonResponse('OpenAI reset credits', response);
    if ('error' in bodyResult) {
      return {
        state: 'unavailable',
        availableCount: 0,
        credits: [],
        errorMessage: bodyResult.error,
      };
    }

    return parseResetCreditsPayload(bodyResult.data);
  } catch (error: unknown) {
    return {
      state: 'unavailable',
      availableCount: 0,
      credits: [],
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
};

const formatCompactResetDate = (dateMs: number): string => {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  }).format(new Date(dateMs));
};

const formatResetCreditsLines = (resetCredits: OpenAIResetCreditsResult): QuotaLine[] => {
  switch (resetCredits.state) {
    case 'available': {
      const countLabel = resetCredits.availableCount === 1 ? '1 available' : `${resetCredits.availableCount} available`;
      const expiryLabel = resetCredits.nextExpiresAtMs
        ? ` · ${formatCompactResetDate(resetCredits.nextExpiresAtMs)}`
        : '';
      const lines: QuotaLine[] = [detailTextLine(`Reset · ${countLabel}${expiryLabel}`)];

      if (resetCredits.nextExpiresAtMs) {
        const nextCredit = resetCredits.credits.find((credit) => {
          if (!credit.expiresAtIso) return false;
          const ms = Date.parse(credit.expiresAtIso);
          return !Number.isNaN(ms) && ms === resetCredits.nextExpiresAtMs;
        });
        if (nextCredit?.grantedAtIso) {
          const grantedMs = Date.parse(nextCredit.grantedAtIso);
          if (!Number.isNaN(grantedMs)) {
            lines.push(detailTextLine(`Granted ${formatCompactResetDate(grantedMs)}`));
          }
        }
      }

      return lines;
    }
    case 'none-available':
      return [detailTextLine('Reset · none')];
    case 'unavailable':
      return [detailTextLine('Reset · unavailable', 'error')];
  }
};

export const formatOpenAILines = (
  data: OpenAIResult,
  displayMode: QuotaDisplayMode,
  fetchedAtMs: number,
): QuotaLine[] => {
  const openAILines: QuotaLine[] = [];
  const sparkLines: QuotaLine[] = [];

  const addWindow = (
    targetLines: QuotaLine[],
    label: string,
    window: OpenAIWindow | undefined,
    paceWindowSeconds?: number,
    tone?: QuotaLineTone,
  ) => {
    if (!window) return;

    targetLines.push(
      windowLine(
        label,
        formatUsedPercentQuota(window.usedPct, displayMode),
        window.resetSec,
        fetchedAtMs,
        tone,
        window.usedPct,
      ),
    );

    if (paceWindowSeconds) {
      targetLines.push(paceLine(window, paceWindowSeconds, fetchedAtMs));
    }
  };

  addWindow(openAILines, '5h', data.hourly);
  addWindow(openAILines, 'Wk', data.weekly, WEEK_SECONDS);
  addWindow(openAILines, 'Code', data.codeReview);

  for (const limit of data.additionalRateLimits ?? []) {
    const tone = formatOpenAIRateLimitTone(limit);

    if (isOpenAISparkRateLimit(limit)) {
      addWindow(sparkLines, '5h', limit.primary, undefined, tone);
      addWindow(sparkLines, 'Wk', limit.secondary, limit.secondary?.limitWindowSec || WEEK_SECONDS, tone);
      continue;
    }

    addWindow(openAILines, formatOpenAIAdditionalRateLimitLabel(limit), limit.primary, undefined, tone);
    addWindow(openAILines, formatOpenAIAdditionalRateLimitLabel(limit, '2nd'), limit.secondary, undefined, tone);
  }

  if (data.credits) {
    openAILines.push(detailTextLine(`Credits ${data.credits}`));
  }

  if (data.resetCredits) {
    openAILines.push(...formatResetCreditsLines(data.resetCredits));
  }

  const lines: QuotaLine[] = [];

  if (openAILines.length) {
    lines.push(headingLine('OpenAI'), ...openAILines);
  }

  if (sparkLines.length) {
    lines.push(headingLine('Spark'), ...sparkLines);
  }

  return lines.length ? lines : [detailTextLine('No windows')];
};

const fetchOpenAIUsagePayload = async (headers: Record<string, string>, signal?: AbortSignal): Promise<OpenAIResult | { error: string }> => {
  const response = await fetchWithTimeout(OPENAI_USAGE_URL, { headers }, undefined, signal);
  if (!response.ok) {
    const text = await response.text().catch((error: unknown) => {
      if (error instanceof Error) return error.message;
      return String(error);
    });
    return { error: httpErrorMessage('OpenAI', response, text) };
  }

  const bodyResult = await readJsonResponse('OpenAI', response);
  if ('error' in bodyResult) return bodyResult;

  const body: unknown = bodyResult.data;
  if (!isRecord(body)) {
    return { error: 'OpenAI did not return a valid usage payload' };
  }

  const rateLimit = isRecord(body.rate_limit) ? body.rate_limit : undefined;
  const additionalRateLimits = parseAdditionalRateLimits(body.additional_rate_limits);
  const codeReviewRateLimit = isRecord(body.code_review_rate_limit) ? body.code_review_rate_limit : undefined;
  const credits = isRecord(body.credits) ? body.credits : undefined;

  const result: OpenAIResult = {
    planType: readStringField(body, 'plan_type') || readStringField(body, 'planType'),
    hourly: parseWindowFromAliases(rateLimit, ['primary_window', 'primary', 'window', 'window_primary', 'hourly']),
    weekly: parseWindowFromAliases(rateLimit, ['secondary_window', 'secondary', 'window_secondary', 'weekly']),
    codeReview: parseWindowFromAliases(codeReviewRateLimit, ['primary_window', 'primary', 'window', 'window_primary']),
    additionalRateLimits,
  };

  if (credits) {
    const unlimited = credits.unlimited === true;
    const hasCredits = credits.has_credits === true || unlimited;
    const balance =
      typeof credits.balance === 'number' && Number.isFinite(credits.balance) ? credits.balance : undefined;
    if (unlimited) {
      result.credits = 'Unlimited';
    } else if (hasCredits && balance !== undefined) {
      result.credits = `$${balance.toFixed(2)}`;
    }
  }

  if (
    !result.hourly &&
    !result.weekly &&
    !result.codeReview &&
    !result.credits &&
    !result.planType &&
    !(result.additionalRateLimits && result.additionalRateLimits.length > 0)
  ) {
    return { error: 'OpenAI did not return expected quota data' };
  }

  return result;
};

export interface FetchOpenAIQuotaOptions {
  experimentalResetCredits?: boolean;
}

export const fetchOpenAIQuota = async (
  options: FetchOpenAIQuotaOptions = {},
  signal?: AbortSignal,
): Promise<OpenAIResult | null | { error: string }> => {
  const token = readOpenAIToken();
  if (!token) return null;

  const headers = buildOpenAIHeaders(token);

  const usagePromise = fetchOpenAIUsagePayload(headers, signal).catch((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
  }));

  const resetCreditsPromise = options.experimentalResetCredits
    ? fetchOpenAIResetCredits(headers, signal)
    : Promise.resolve<OpenAIResetCreditsResult>({
        state: 'unavailable',
        availableCount: 0,
        credits: [],
        errorMessage:
          'Reset credits fetching is disabled by default (experimental). Set experimentalOpenAIResetCredits: true to enable.',
      });

  const [usageResult, resetCreditsResult] = await Promise.all([usagePromise, resetCreditsPromise]);

  if ('error' in usageResult) return usageResult;

  const result: OpenAIResult = usageResult;
  if (options.experimentalResetCredits) {
    result.resetCredits = resetCreditsResult;
  }

  return result;
};
