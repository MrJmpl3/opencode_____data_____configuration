import type { TuiPluginModule } from '@opencode-ai/plugin/tui';

import { registerLimitsTui } from './src/runtime/runtime.tsx';

export { getModelFromMessages, readModelRecord, readString, resolveModel } from './src/domain/model.ts';
export type { MessageModel, ModelLimits, ProviderModelRecord, ProviderRecord } from './src/domain/model.ts';
export { registerLimitsTui } from './src/runtime/runtime.tsx';
export {
  detailLine,
  eventProperties,
  eventSessionId,
  formatCompactNumber,
  isRecord,
  slotSessionId,
} from './src/runtime/tui.ts';

const plugin: TuiPluginModule & { id: string } = {
  id: 'limits',
  tui: registerLimitsTui,
};

export default plugin;
