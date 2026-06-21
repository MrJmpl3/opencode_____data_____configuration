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
  experimentalOpenAIResetCredits: boolean;
}

interface ResolvedQuotaPluginOptionsDiagnostics {
  invalidVisibleProviderEntries: readonly string[];
  fellBackToDefaultVisibleProviders: boolean;
}

interface InspectedQuotaPluginOptions {
  options: ResolvedQuotaPluginOptions;
  diagnostics: ResolvedQuotaPluginOptionsDiagnostics;
}

const PROVIDER_SPECS: readonly ProviderSpec[] = [
  { id: 'opencode-go', label: 'OpenCode Go' },
  { id: 'github-copilot', label: 'GitHub Copilot' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'openai', label: 'OpenAI' },
];

export const DEFAULT_VISIBLE_PROVIDERS: readonly QuotaProviderId[] = ['opencode-go', 'github-copilot', 'openrouter'];
export const ALLOWED_VISIBLE_PROVIDER_IDS: readonly QuotaProviderId[] = PROVIDER_SPECS.map((spec) => spec.id);
const DEFAULT_POLL_INTERVAL_MS = 10 * 60_000;
const DEFAULT_MIN_REFRESH_INTERVAL_MS = 120_000;
const DEFAULT_PROVIDER_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_PROVIDER_ERROR_BACKOFF_MS = 15 * 60_000;
const MIN_SAFE_REFRESH_INTERVAL_MS = 60_000;
const MIN_SAFE_CACHE_TTL_MS = 60_000;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const defaultVisibleProviderSpecs = (): readonly ProviderSpec[] => {
  return PROVIDER_SPECS.filter((spec) => DEFAULT_VISIBLE_PROVIDERS.includes(spec.id));
};

const formatInvalidVisibleProviderEntry = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const inspectVisibleProviders = (
  options: unknown,
): {
  visibleProviders: readonly ProviderSpec[];
  invalidVisibleProviderEntries: readonly string[];
  fellBackToDefaultVisibleProviders: boolean;
} => {
  const configured = isRecord(options) ? options.visibleProviders : undefined;
  if (!Array.isArray(configured) || configured.length === 0) {
    return {
      visibleProviders: defaultVisibleProviderSpecs(),
      invalidVisibleProviderEntries: [],
      fellBackToDefaultVisibleProviders: false,
    };
  }

  const resolvedProviders: ProviderSpec[] = [];
  const invalidVisibleProviderEntries: string[] = [];
  const seenProviderIds = new Set<QuotaProviderId>();

  for (const raw of configured) {
    if (typeof raw !== 'string') {
      invalidVisibleProviderEntries.push(formatInvalidVisibleProviderEntry(raw));
      continue;
    }

    const providerSpec = PROVIDER_SPECS.find((spec) => spec.id === raw);
    if (!providerSpec) {
      invalidVisibleProviderEntries.push(formatInvalidVisibleProviderEntry(raw));
      continue;
    }

    if (seenProviderIds.has(providerSpec.id)) continue;

    seenProviderIds.add(providerSpec.id);
    resolvedProviders.push(providerSpec);
  }

  if (resolvedProviders.length === 0) {
    return {
      visibleProviders: defaultVisibleProviderSpecs(),
      invalidVisibleProviderEntries,
      fellBackToDefaultVisibleProviders: invalidVisibleProviderEntries.length > 0,
    };
  }

  return {
    visibleProviders: resolvedProviders,
    invalidVisibleProviderEntries,
    fellBackToDefaultVisibleProviders: false,
  };
};

const getDisplayModeSetting = (options: unknown): QuotaDisplayMode => {
  if (!isRecord(options)) return 'remaining';
  return options.displayMode === 'used' ? 'used' : 'remaining';
};

const getNumberOption = (
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

const getBooleanOption = (options: unknown, key: keyof QuotaPluginOptions): boolean => {
  if (!isRecord(options)) return false;
  return options[key] === true;
};

export const inspectQuotaPluginOptions = (options: unknown): InspectedQuotaPluginOptions => {
  const visibleProviders = inspectVisibleProviders(options);

  const resolvedOptions: ResolvedQuotaPluginOptions = {
    displayMode: getDisplayModeSetting(options),
    visibleProviders: visibleProviders.visibleProviders,
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
    experimentalOpenAIResetCredits: getBooleanOption(options, 'experimentalOpenAIResetCredits'),
  };

  return {
    options: resolvedOptions,
    diagnostics: {
      invalidVisibleProviderEntries: visibleProviders.invalidVisibleProviderEntries,
      fellBackToDefaultVisibleProviders: visibleProviders.fellBackToDefaultVisibleProviders,
    },
  };
};

export const normalizeQuotaPluginOptions = (options: unknown): ResolvedQuotaPluginOptions => {
  return inspectQuotaPluginOptions(options).options;
};

export const resolveQuotaPluginOptions = normalizeQuotaPluginOptions;
