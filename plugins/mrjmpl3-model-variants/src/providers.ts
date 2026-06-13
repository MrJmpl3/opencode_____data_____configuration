import type { ModelVariants, ProviderEntry } from './types.ts';

export function normalizeProviderList(result: unknown): ProviderEntry[] {
  const data = (result as { data?: unknown } | undefined)?.data ?? result;
  return ((data as { all?: unknown; providers?: unknown } | undefined)?.all ??
    (data as { all?: unknown; providers?: unknown } | undefined)?.providers ??
    (Array.isArray(data) ? data : [])) as ProviderEntry[];
}

export function extractModelVariants(providerList: ProviderEntry[]): ModelVariants {
  const variants: ModelVariants = {};

  for (const provider of providerList) {
    for (const [modelId, model] of Object.entries(provider.models ?? {})) {
      if (model.variants && Object.keys(model.variants).length > 0) {
        variants[provider.id] = variants[provider.id] || {};
        variants[provider.id][modelId] = Object.keys(model.variants).sort();
      }
    }
  }

  return variants;
}
