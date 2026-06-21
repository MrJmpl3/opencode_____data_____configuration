export type QuotaProviderId = 'opencode-go' | 'github-copilot' | 'openrouter' | 'openai';
export type QuotaDisplayMode = 'remaining' | 'used';
export type QuotaLineTone = 'neutral' | 'success' | 'warning' | 'error';

export interface QuotaPluginOptions {
  displayMode?: QuotaDisplayMode;
  visibleProviders?: readonly string[];
  pollIntervalMs?: number;
  minRefreshIntervalMs?: number;
  providerCacheTtlMs?: number;
  providerErrorBackoffMs?: number;
  /**
   * EXPERIMENTAL — OFF by default.
   * Enables fetching OpenAI reset-credits from an undocumented private ChatGPT endpoint.
   * This endpoint is unsupported, may break without notice, and uses client-impersonation headers.
   * Only enable if you accept those risks.
   */
  experimentalOpenAIResetCredits?: boolean;
}

export interface ProviderSpec {
  id: QuotaProviderId;
  label: string;
}

export interface PercentWindow {
  usedPct: number;
  resetSec: number;
  limitWindowSec?: number;
}

export interface GoWindow {
  used: number;
  remaining: number;
  resetInSec: number;
}

export interface CopilotResult {
  text: string;
  used?: number;
  remaining?: number;
  total?: number;
  pctRemaining?: number;
  unlimited?: boolean;
  resetTimeIso?: string;
  resetSec?: number;
}

export interface OpenRouterResult {
  text: string;
  remaining?: number;
  total?: number;
  usage?: number;
}

export interface OpenAIWindow extends PercentWindow {}

export interface OpenAIAdditionalRateLimit {
  label: string;
  limitName?: string;
  meteredFeature?: string;
  allowed?: boolean;
  limitReached?: boolean;
  primary?: OpenAIWindow;
  secondary?: OpenAIWindow;
}

export type OpenAIResetCreditStatus = 'available' | 'redeemed' | 'expired' | 'redeeming';

export interface OpenAIResetCredit {
  grantedAtIso?: string;
  expiresAtIso?: string;
  status?: OpenAIResetCreditStatus;
}

export type OpenAIResetCreditsState = 'available' | 'none-available' | 'unavailable';

export interface OpenAIResetCreditsResult {
  state: OpenAIResetCreditsState;
  availableCount: number;
  credits: readonly OpenAIResetCredit[];
  nextExpiresAtMs?: number;
  errorMessage?: string;
}

export interface OpenAIResult {
  planType?: string;
  hourly?: OpenAIWindow;
  weekly?: OpenAIWindow;
  codeReview?: OpenAIWindow;
  credits?: string;
  additionalRateLimits?: OpenAIAdditionalRateLimit[];
  resetCredits?: OpenAIResetCreditsResult;
}
