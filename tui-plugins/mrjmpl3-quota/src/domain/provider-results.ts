import type { QuotaLine } from './lines.ts';
import type { QuotaDisplayMode, QuotaProviderId } from './types.ts';
import { fetchCopilotQuota, formatCopilotLines } from '../infrastructure/providers/copilot.ts';
import { fetchGoDashboard, formatGoLines, readGoConfig } from '../infrastructure/providers/go.ts';
import { fetchOpenAIQuota, formatOpenAILines } from '../infrastructure/providers/openai.ts';
import { fetchOpenRouterQuota, formatOpenRouterLines } from '../infrastructure/providers/openrouter.ts';

export type GoConfig = ReturnType<typeof readGoConfig>;
type CachedProviderValue = QuotaLine[] | string;
export type ProviderFetchResult = CachedProviderValue | undefined;
export type ProviderResult = QuotaLine[] | string | null;

export interface FetchProviderLinesArgs {
  providerId: QuotaProviderId;
  goConfig: GoConfig;
  displayMode: QuotaDisplayMode;
  setNowMs: (nowMs: number) => void;
  experimentalOpenAIResetCredits?: boolean;
}

export const fetchProviderLines = async (args: FetchProviderLinesArgs): Promise<ProviderFetchResult> => {
  const { providerId, goConfig, displayMode, setNowMs, experimentalOpenAIResetCredits } = args;

  switch (providerId) {
    case 'opencode-go': {
      if (!goConfig) return undefined;

      const result = await fetchGoDashboard(goConfig.workspaceId, goConfig.authCookie);
      if (!('data' in result)) return result.error;

      const fetchedAtMs = Date.now();
      setNowMs(fetchedAtMs);
      return formatGoLines(result.data, displayMode, fetchedAtMs);
    }

    case 'github-copilot': {
      const copilotResult = await fetchCopilotQuota();
      if (copilotResult === null) return undefined;
      if ('error' in copilotResult) return copilotResult.error;

      const fetchedAtMs = Date.now();
      setNowMs(fetchedAtMs);
      return formatCopilotLines(copilotResult, displayMode, fetchedAtMs);
    }

    case 'openrouter': {
      const openRouterResult = await fetchOpenRouterQuota();
      if (openRouterResult === null) return undefined;
      if ('error' in openRouterResult) return openRouterResult.error;
      return formatOpenRouterLines(openRouterResult, displayMode);
    }

    case 'openai': {
      const openAIResult = await fetchOpenAIQuota({
        experimentalResetCredits: experimentalOpenAIResetCredits === true,
      });
      if (openAIResult === null) return undefined;
      if ('error' in openAIResult) return openAIResult.error;

      const fetchedAtMs = Date.now();
      setNowMs(fetchedAtMs);
      return formatOpenAILines(openAIResult, displayMode, fetchedAtMs);
    }
  }
};
