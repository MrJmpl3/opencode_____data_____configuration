import type { Plugin } from '@opencode-ai/plugin';

import { writeVariantsCache } from './cache.ts';
import { extractModelVariants, normalizeProviderList } from './providers.ts';

export const ModelVariantsPlugin: Plugin = async (input) => {
  async function refreshVariantsCache(): Promise<void> {
    try {
      const result = await input.client.provider.list();
      const providerList = normalizeProviderList(result);
      const variants = extractModelVariants(providerList);

      // Always rewrite the cache, even when the provider list yields no variants.
      // An empty write clears stale data from previous runs instead of leaving it behind.
      await writeVariantsCache(variants);
    } catch (error) {
      console.error('[model-variants] cache refresh failed:', error);
    }
  }

  // Plugin init happens before the server is fully ready, so kick off the refresh in the
  // background and surface any unexpected failure through the fallback error handler.
  refreshVariantsCache().catch((error) => {
    console.error('[model-variants] unexpected refresh error:', error);
  });

  return {};
};

export default ModelVariantsPlugin;
