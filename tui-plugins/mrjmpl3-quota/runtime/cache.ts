import { fmtDuration } from '../providers.ts';
import { isQuotaRateLimitError, retryAfterMsFromMessage } from './format.ts';
import { MAX_PROVIDER_BACKOFF_MS } from './options.ts';
import type { QuotaProviderId } from './options.ts';
import type { GoConfig, ProviderFetchResult } from './provider-results.ts';
import type { CachedProviderValue } from './provider-results.ts';

export type ProviderCacheEntry = {
  value?: CachedProviderValue;
  fetchedAtMs: number;
  cooldownUntilMs?: number;
  consecutiveErrors: number;
  inFlight?: Promise<ProviderFetchResult>;
};

type QuotaProviderCacheConfig = {
  providerCacheTtlMs: number;
  providerErrorBackoffMs: number;
  fetchProviderLines: (providerId: QuotaProviderId, goConfig: GoConfig) => Promise<ProviderFetchResult>;
};

export const createQuotaProviderCache = ({
  providerCacheTtlMs,
  providerErrorBackoffMs,
  fetchProviderLines,
}: QuotaProviderCacheConfig): {
  providerCache: Map<QuotaProviderId, ProviderCacheEntry>;
  getCachedProviderLines: (providerId: QuotaProviderId, goConfig: GoConfig) => Promise<ProviderFetchResult>;
} => {
  const providerCache = new Map<QuotaProviderId, ProviderCacheEntry>();

  const getErrorCooldownMs = (message: string, attempts: number): number => {
    const retryAfterMs = retryAfterMsFromMessage(message);
    const baseMs = isQuotaRateLimitError(message) ? providerErrorBackoffMs : providerCacheTtlMs;
    const multipliedMs = baseMs * Math.min(4, Math.max(1, attempts));
    return Math.max(retryAfterMs, Math.min(multipliedMs, MAX_PROVIDER_BACKOFF_MS));
  };

  const cacheProviderResult = (providerId: QuotaProviderId, value: ProviderFetchResult): ProviderFetchResult => {
    if (value === undefined) {
      providerCache.delete(providerId);
      return undefined;
    }

    const now = Date.now();
    const previous = providerCache.get(providerId);
    const consecutiveErrors = typeof value === 'string' ? (previous?.consecutiveErrors ?? 0) + 1 : 0;
    providerCache.set(providerId, {
      value,
      fetchedAtMs: now,
      consecutiveErrors,
      cooldownUntilMs: typeof value === 'string' ? now + getErrorCooldownMs(value, consecutiveErrors) : undefined,
    });
    return value;
  };

  const getCachedProviderLines = async (
    providerId: QuotaProviderId,
    goConfig: GoConfig,
  ): Promise<ProviderFetchResult> => {
    const now = Date.now();
    const entry = providerCache.get(providerId);
    if (entry?.inFlight) return entry.inFlight;
    if (entry?.cooldownUntilMs && entry.cooldownUntilMs > now) {
      return entry.value ?? `Refresh paused · retry in ${fmtDuration(Math.ceil((entry.cooldownUntilMs - now) / 1000))}`;
    }
    if (entry?.value !== undefined && now - entry.fetchedAtMs < providerCacheTtlMs) {
      return entry.value;
    }

    const request = fetchProviderLines(providerId, goConfig)
      .then((value) => cacheProviderResult(providerId, value))
      .catch((error: unknown) => {
        const message = `Error: ${error instanceof Error ? error.message : String(error)}`;
        return cacheProviderResult(providerId, message);
      });

    providerCache.set(providerId, {
      value: entry?.value,
      fetchedAtMs: entry?.fetchedAtMs ?? 0,
      cooldownUntilMs: entry?.cooldownUntilMs,
      consecutiveErrors: entry?.consecutiveErrors ?? 0,
      inFlight: request,
    });

    return request;
  };

  return { providerCache, getCachedProviderLines };
};
