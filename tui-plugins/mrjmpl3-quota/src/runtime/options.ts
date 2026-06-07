import type { ProviderSpec, QuotaDisplayMode, QuotaPluginOptions, QuotaProviderId } from '../domain/types.ts';

export type { QuotaPluginOptions } from '../domain/types.ts';

export type QuotaPluginConfigEntry = readonly [pluginSpec: string, options: QuotaPluginOptions];

export interface ResolvedQuotaPluginOptions {
  displayMode: QuotaDisplayMode;
  visibleProviders: readonly ProviderSpec[];
  pollIntervalMs: number;
  minRefreshIntervalMs: number;
  providerCacheTtlMs: number;
  providerErrorBackoffMs: number;
}

export const PROVIDER_SPECS: readonly ProviderSpec[] = [
  { id: 'go', label: 'OpenCode Go' },
  { id: 'copilot', label: 'GitHub Copilot' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'openai', label: 'OpenAI' },
];

export const DEFAULT_VISIBLE_PROVIDERS: readonly QuotaProviderId[] = ['go', 'copilot', 'openrouter'];
export const DEFAULT_POLL_INTERVAL_MS = 10 * 60_000;
export const DEFAULT_MIN_REFRESH_INTERVAL_MS = 120_000;
export const DEFAULT_PROVIDER_CACHE_TTL_MS = 5 * 60_000;
export const DEFAULT_PROVIDER_ERROR_BACKOFF_MS = 15 * 60_000;
export const MIN_SAFE_REFRESH_INTERVAL_MS = 60_000;
export const MIN_SAFE_CACHE_TTL_MS = 60_000;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const defaultVisibleProviderSpecs = (): readonly ProviderSpec[] => {
  return PROVIDER_SPECS.filter((spec) => DEFAULT_VISIBLE_PROVIDERS.includes(spec.id));
};

const normalizeProviderId = (value: string): QuotaProviderId | undefined => {
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case 'go':
    case 'opencode-go':
      return 'go';
    case 'copilot':
    case 'cp':
    case 'github-copilot':
      return 'copilot';
    case 'openrouter':
    case 'or':
      return 'openrouter';
    case 'openai':
    case 'oa':
    case 'chatgpt':
      return 'openai';
    default:
      return undefined;
  }
};

export const getVisibleProviders = (options: unknown): readonly ProviderSpec[] => {
  const configured = isRecord(options) ? options.visibleProviders : undefined;
  if (!Array.isArray(configured) || configured.length === 0) {
    return defaultVisibleProviderSpecs();
  }

  const ids = new Set<QuotaProviderId>();
  for (const raw of configured) {
    if (typeof raw !== 'string') continue;
    const id = normalizeProviderId(raw);
    if (id) ids.add(id);
  }

  if (ids.size === 0) {
    return defaultVisibleProviderSpecs();
  }

  return PROVIDER_SPECS.filter((spec) => ids.has(spec.id));
};

export const getDisplayModeSetting = (options: unknown): QuotaDisplayMode => {
  if (!isRecord(options)) return 'remaining';
  return options.displayMode === 'used' ? 'used' : 'remaining';
};

export const getNumberOption = (
  options: unknown,
  key: keyof QuotaPluginOptions,
  fallback: number,
  minimum: number,
  allowZero = false,
): number => {
  if (!isRecord(options)) return fallback;
  const value = options[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (allowZero && value === 0) return 0;
  return Math.max(minimum, value);
};

export const normalizeQuotaPluginOptions = (options: unknown): ResolvedQuotaPluginOptions => {
  return {
    displayMode: getDisplayModeSetting(options),
    visibleProviders: getVisibleProviders(options),
    pollIntervalMs: getNumberOption(
      options,
      'pollIntervalMs',
      DEFAULT_POLL_INTERVAL_MS,
      MIN_SAFE_REFRESH_INTERVAL_MS,
      true,
    ),
    minRefreshIntervalMs: getNumberOption(
      options,
      'minRefreshIntervalMs',
      DEFAULT_MIN_REFRESH_INTERVAL_MS,
      MIN_SAFE_REFRESH_INTERVAL_MS,
    ),
    providerCacheTtlMs: getNumberOption(
      options,
      'providerCacheTtlMs',
      DEFAULT_PROVIDER_CACHE_TTL_MS,
      MIN_SAFE_CACHE_TTL_MS,
    ),
    providerErrorBackoffMs: getNumberOption(
      options,
      'providerErrorBackoffMs',
      DEFAULT_PROVIDER_ERROR_BACKOFF_MS,
      MIN_SAFE_CACHE_TTL_MS,
    ),
  };
};

export const resolveQuotaPluginOptions = normalizeQuotaPluginOptions;
