import type { TuiPluginModule } from '@opencode-ai/plugin/tui';

import { formatResponsibleUsagePace, formatResponsibleWeeklyUsage } from './src/domain/format.ts';
import { isQuotaRateLimitError, retryAfterMsFromMessage } from './src/infrastructure/retry-policy.ts';
import { registerQuotaTui } from './src/runtime/runtime.tsx';

export { formatResponsibleUsagePace, formatResponsibleWeeklyUsage, isQuotaRateLimitError, retryAfterMsFromMessage };

const plugin: TuiPluginModule & { id: string } = {
  id: 'quota',
  tui: registerQuotaTui,
};

export default plugin;
