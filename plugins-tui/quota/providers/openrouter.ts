import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import os from 'os';

import { OPENROUTER_CREDITS_URL } from './constants.js';
import { fetchWithTimeout, httpErrorMessage, readJsonResponse } from './http.js';
import type { OpenRouterResult } from './types.js';

export const readOpenRouterKey = (): string | null => {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (key) return key;

  try {
    const path = join(os.homedir(), '.config', 'opencode', 'openrouter-auth.json');
    if (existsSync(path)) {
      const raw: Record<string, unknown> = JSON.parse(readFileSync(path, 'utf-8'));
      for (const k of ['apiKey', 'api_key', 'token', 'openrouterApiKey'] as const) {
        const value = raw[k];
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

  const body: unknown = bodyResult.data;
  const d = (body as Record<string, unknown>)?.data ?? body;

  const totalCredits =
    typeof (d as Record<string, unknown>).total_credits === 'number' &&
    Number.isFinite((d as Record<string, unknown>).total_credits)
      ? ((d as Record<string, unknown>).total_credits as number)
      : null;
  const totalUsage =
    typeof (d as Record<string, unknown>).total_usage === 'number' &&
    Number.isFinite((d as Record<string, unknown>).total_usage)
      ? ((d as Record<string, unknown>).total_usage as number)
      : null;

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
