import type { TuiPluginModule } from '@opencode-ai/plugin/tui';

import { registerCacheTui } from './src/runtime/runtime.tsx';

export { summarizeCacheMessages } from './src/domain/summary.ts';
export type { CacheSummary } from './src/domain/summary.ts';
export { registerCacheTui } from './src/runtime/runtime.tsx';
export {
  detailLine,
  eventSessionId,
  formatCompactNumber,
  formatPercentRatio,
  slotSessionId,
} from '@mrjmpl3/tui-kit';

const plugin: TuiPluginModule & { id: string } = {
  id: 'cache',
  tui: registerCacheTui,
};

export default plugin;
