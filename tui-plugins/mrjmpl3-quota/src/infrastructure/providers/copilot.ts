import type { CopilotResult } from '../../domain/types.ts';
import type { QuotaLine } from '../../domain/lines.ts';
import type { QuotaDisplayMode } from '../../domain/types.ts';
import { formatCountQuota, MONTH_SECONDS } from '../../domain/format.ts';
import { detailTextLine, paceLine, windowLine } from '../../domain/lines.ts';
import { readOauthAccessToken } from './auth.ts';
import { GITHUB_API, USER_AGENT } from './constants.ts';
import { fetchWithTimeout, httpErrorMessage, readJsonResponse } from './http.ts';
import { findBoolean, findNumber, findString } from './shared.ts';

const readCopilotToken = (): string | null => {
  return readOauthAccessToken(['github-copilot', 'copilot', 'copilot-chat', 'github-copilot-chat']);
};

const COPILOT_TOTAL_PATHS = [
  ['quota', 'limit'],
  ['quota', 'total'],
  ['monthly_quota', 'limit'],
  ['monthly_quota', 'total'],
  ['monthly_premium_requests', 'limit'],
  ['monthly_premium_requests', 'total'],
  ['premium_requests', 'limit'],
  ['premium_requests', 'total'],
  ['quota_snapshots', 'premium_interactions', 'entitlement'],
  ['limit'],
  ['total'],
  ['quota_limit'],
  ['monthly_limit'],
  ['included_premium_requests'],
  ['monthly_quotas', 'chat'],
  ['monthly_quotas', 'completions'],
] as const;

const COPILOT_USED_PATHS = [
  ['quota', 'used'],
  ['monthly_quota', 'used'],
  ['monthly_premium_requests', 'used'],
  ['premium_requests', 'used'],
  ['used'],
  ['quota_used'],
  ['monthly_used'],
  ['premium_requests_used'],
] as const;

const COPILOT_REMAINING_PATHS = [
  ['quota', 'remaining'],
  ['monthly_quota', 'remaining'],
  ['monthly_premium_requests', 'remaining'],
  ['premium_requests', 'remaining'],
  ['quota_snapshots', 'premium_interactions', 'remaining'],
  ['quota_snapshots', 'premium_interactions', 'quota_remaining'],
  ['remaining'],
  ['quota_remaining'],
  ['monthly_remaining'],
  ['premium_requests_remaining'],
  ['limited_user_quotas', 'chat'],
  ['limited_user_quotas', 'completions'],
] as const;

const COPILOT_RESET_PATHS = [
  ['quota', 'reset_at'],
  ['monthly_quota', 'reset_at'],
  ['monthly_premium_requests', 'reset_at'],
  ['premium_requests', 'reset_at'],
  ['reset_at'],
  ['quota_reset_date_utc'],
  ['quota_reset_date'],
  ['limited_user_reset_date'],
] as const;

const COPILOT_UNLIMITED_PATHS = [
  ['quota', 'unlimited'],
  ['monthly_quota', 'unlimited'],
  ['monthly_premium_requests', 'unlimited'],
  ['premium_requests', 'unlimited'],
  ['quota_snapshots', 'premium_interactions', 'unlimited'],
  ['unlimited'],
] as const;

const COPILOT_TIER_PATHS = [
  ['plan', 'type'],
  ['plan', 'name'],
  ['plan'],
  ['copilot_plan'],
  ['subscription_plan'],
  ['sku'],
] as const;

const COPILOT_TIER_LIMITS: Record<string, number> = {
  free: 50,
  pro: 300,
  'pro+': 1500,
  business: 300,
  enterprise: 1000,
};

export const normalizeCopilotResetAtMs = (resetAt: number): number =>
  resetAt > 1_000_000_000_000 ? resetAt : resetAt * 1000;

export const formatCopilotLines = (
  data: CopilotResult,
  displayMode: QuotaDisplayMode,
  fetchedAtMs: number,
): QuotaLine[] => {
  const value = formatCountQuota(data, displayMode);
  const lines: QuotaLine[] = [];

  if (data.resetSec) {
    lines.push(windowLine('Mo', value, data.resetSec, fetchedAtMs));

    if (data.pctRemaining !== undefined) {
      const usedPct = Math.max(0, 100 - data.pctRemaining);
      lines.push(paceLine({ usedPct, resetSec: data.resetSec }, MONTH_SECONDS, fetchedAtMs));
    }
  } else {
    lines.push(detailTextLine(`Monthly ${value}`));
  }

  return lines;
};

export const fetchCopilotQuota = async (): Promise<CopilotResult | null | { error: string }> => {
  const token = readCopilotToken();
  if (!token) return null;

  const response = await fetchWithTimeout(`${GITHUB_API}/copilot_internal/user`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': USER_AGENT,
    },
  });
  if (!response.ok) return { error: httpErrorMessage('Copilot API', response) };

  const dataResult = await readJsonResponse('Copilot API', response);
  if ('error' in dataResult) return dataResult;

  const data: unknown = dataResult.data;

  let total = findNumber(data, COPILOT_TOTAL_PATHS);
  let used = findNumber(data, COPILOT_USED_PATHS);
  const remaining = findNumber(data, COPILOT_REMAINING_PATHS);
  const unlimited = findBoolean(data, COPILOT_UNLIMITED_PATHS) === true;
  const tier = findString(data, COPILOT_TIER_PATHS);

  if (total === undefined && used !== undefined && remaining !== undefined) total = used + remaining;
  if (used === undefined && total !== undefined && remaining !== undefined) used = Math.max(0, total - remaining);
  if (total === undefined && tier) total = COPILOT_TIER_LIMITS[tier.toLowerCase()] ?? COPILOT_TIER_LIMITS.pro;

  if (unlimited) return { text: 'Unlimited', unlimited: true };

  if (total === undefined || total <= 0 || used === undefined || used < 0) {
    return { error: 'Could not extract Copilot quota data' };
  }

  const resetAt = findNumber(data, COPILOT_RESET_PATHS);
  const resetTimeIso = resetAt
    ? new Date(normalizeCopilotResetAtMs(resetAt)).toISOString()
    : new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1)).toISOString();
  const resetSec = Math.max(0, Math.floor((new Date(resetTimeIso).getTime() - Date.now()) / 1000));

  const remainingCount = Math.max(0, total - used);
  return {
    text: `${remainingCount}/${total}`,
    used,
    remaining: remainingCount,
    total,
    pctRemaining: Math.round((remainingCount / total) * 100),
    resetTimeIso,
    resetSec,
  };
};
