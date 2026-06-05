import type { TuiPluginModule } from '@opencode-ai/plugin/tui';

import { registerSubagentStatusTui } from './src/runtime/runtime.tsx';

const plugin: TuiPluginModule & { id: string } = {
  id: 'mrjmpl3-subagent-status',
  tui: registerSubagentStatusTui,
};

export default plugin;
