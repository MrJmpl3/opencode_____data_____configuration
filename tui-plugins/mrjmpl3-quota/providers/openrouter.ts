import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import os from 'os';

import { OPENROUTER_CREDITS_URL } from './constants.ts';
import { fetchWithTimeout, httpErrorMessage, readJsonResponse } from './http.ts';
import { isRecord } from './shared.ts';
import type { OpenRouterResult } from './types.ts';

export const readOpenRouterKey = (): string | null => {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (key) return key;

  try {
    const path = join(os.homedir(), '.config', 'opencode', 'openrouter-auth.json');
    if (existsSync(path)) {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
      if (!isRecord(parsed)) return null;
      for (const k of ['apiKey', 'api_key', 'token', 'openrouterApiKey'] as const) {
        const value = parsed[k];
        if (value && typeof value === 'string') return value.trim();
      }
    }
  } catch {
    return null;
  }
  return null;
};

export const fetchOpenRouterQuota = async (): Promise<OpenRouterResult | null | { error: string }> => {
  const key = readOpenRouterKey();
  if (!key) return null;

  const res = await fetchWithTimeout(OPENROUTER_CREDITS_URL, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { error: httpErrorMessage('OpenRouter', res, text) };
  }

  const bodyResult = await readJsonResponse('OpenRouter', res);
  if ('error' in bodyResult) return bodyResult;

  const body = bodyResult.data;
  const data = isRecord(body) && isRecord(body.data) ? body.data : body;
  if (!isRecord(data)) {
    return { error: 'OpenRouter did not return expected credit data' };
  }

  const totalCredits =
    typeof data.total_credits === 'number' && Number.isFinite(data.total_credits) ? data.total_credits : null;
  const totalUsage =
    typeof data.total_usage === 'number' && Number.isFinite(data.total_usage) ? data.total_usage : null;

  if (totalCredits !== null && totalCredits > 0) {
    const usage = totalUsage ?? 0;
    const remaining = Math.max(0, totalCredits - (totalUsage ?? 0));
    return {
      text: `$${remaining.toFixed(2)}`,
      remaining,
      total: totalCredits,
      usage,
    };
  }

  if (totalUsage !== null) {
    return {
      text: `$${totalUsage.toFixed(4)} used (no limit)`,
      usage: totalUsage,
    };
  }

  return { error: 'OpenRouter did not return expected credit data' };
};
