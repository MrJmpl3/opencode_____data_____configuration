import type { TuiPluginModule } from '@opencode-ai/plugin/tui';

import { registerQuotaTui } from './runtime/runtime.tsx';

export {
  formatResponsibleUsagePace,
  formatResponsibleWeeklyUsage,
  isQuotaRateLimitError,
  retryAfterMsFromMessage,
} from './runtime/format.ts';

const plugin: TuiPluginModule & { id: string } = {
  id: 'quota',
  tui: registerQuotaTui,
};

export default plugin;
