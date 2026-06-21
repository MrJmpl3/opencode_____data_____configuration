import type { TuiPluginModule } from '@opencode-ai/plugin/tui';

import {
  computeRecoverySeconds,
  formatResponsibleUsagePace,
  formatResponsibleWeeklyUsage,
  formatResetCreditDate,
} from './src/domain/format.ts';
import { isQuotaRateLimitError, retryAfterMsFromMessage } from './src/infrastructure/retry-policy.ts';
import { registerQuotaTui } from './src/runtime/runtime.tsx';

export { resolveQuotaPluginOptions, normalizeQuotaPluginOptions } from './src/runtime/options.ts';
export type { QuotaPluginConfigEntry, QuotaPluginOptions, ResolvedQuotaPluginOptions } from './src/runtime/options.ts';
export type {
  OpenAIResetCredit,
  OpenAIResetCreditStatus,
  OpenAIResetCreditsResult,
  OpenAIResetCreditsState,
} from './src/domain/types.ts';
export {
  computeRecoverySeconds,
  formatResponsibleUsagePace,
  formatResponsibleWeeklyUsage,
  formatResetCreditDate,
  isQuotaRateLimitError,
  retryAfterMsFromMessage,
};
export { parseResetCreditsPayload } from './src/infrastructure/providers/openai.ts';

const plugin: TuiPluginModule & { id: string } = {
  id: 'quota',
  tui: registerQuotaTui,
};

export default plugin;
