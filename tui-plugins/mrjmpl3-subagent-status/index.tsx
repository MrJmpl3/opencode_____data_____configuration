import type { TuiPluginModule } from '@opencode-ai/plugin/tui';

import { registerSubagentStatusTui } from './src/runtime/runtime.tsx';

export {
  DEFAULT_STALE_RUNNING_PROBE_POLICY,
  normalizeSubagentStatusPluginOptions,
  resolveSubagentStatusPluginOptions,
} from './src/runtime/options.ts';
export type {
  ResolvedSubagentStatusPluginOptions,
  StaleRunningProbePolicy,
  SubagentStatusPersistenceOptions,
  SubagentStatusPluginConfigEntry,
  SubagentStatusPluginOptions,
  SubagentStatusRecoveryOptions,
  SubagentStatusStaleRunningProbePolicyOptions,
} from './src/runtime/options.ts';

const plugin: TuiPluginModule & { id: string } = {
  id: 'mrjmpl3-subagent-status',
  tui: registerSubagentStatusTui,
};

export default plugin;
