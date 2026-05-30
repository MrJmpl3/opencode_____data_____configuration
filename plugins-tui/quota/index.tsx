import type { TuiPluginModule } from '@opencode-ai/plugin/tui';

import { registerQuotaTui } from './runtime/runtime.js';

export {
  formatResponsibleUsagePace,
  formatResponsibleWeeklyUsage,
  isQuotaRateLimitError,
  retryAfterMsFromMessage,
} from './runtime/format.js';

const plugin: TuiPluginModule & { id: string } = {
  id: 'quota',
  tui: registerQuotaTui,
};

export default plugin;
