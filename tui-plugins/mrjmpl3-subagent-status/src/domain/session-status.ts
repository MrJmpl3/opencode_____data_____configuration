import type { SubagentStatus } from './types.ts';

import { isPlainObject as isRecord, normalizedString } from '@mrjmpl3/tui-kit';

export type TerminalSubagentStatus = Exclude<SubagentStatus, 'running'>;

const RUNNING_SESSION_STATUS_VALUES = new Set([
  'busy',
  'running',
  'pending',
  'queued',
  'in_progress',
  'working',
  'compacting',
  'retry',
]);

const DONE_SESSION_STATUS_VALUES = new Set(['done', 'completed', 'complete', 'success', 'succeeded']);

const ERROR_SESSION_STATUS_VALUES = new Set([
  'error',
  'failed',
  'failure',
  'cancelled',
  'canceled',
  'aborted',
  'abandoned',
  'orphaned',
  'stale',
  'zombie',
]);

export const collectSessionStatusValues = (value: unknown): string[] => {
  const direct = normalizedString(value);
  if (direct) return [direct];

  const record = isRecord(value) ? value : undefined;
  if (!record) return [];

  const statuses = [record.type, record.status, record.state, record.phase, record.result]
    .map(normalizedString)
    .filter((candidate): candidate is string => Boolean(candidate));

  if (record.error) statuses.push('error');
  if (record.busy === true || record.running === true) statuses.push('busy');

  return statuses;
};

export const deriveSessionStatus = (value: unknown): SubagentStatus | undefined => {
  const statuses = collectSessionStatusValues(value);
  if (statuses.some((status) => ERROR_SESSION_STATUS_VALUES.has(status))) return 'error';
  if (statuses.some((status) => RUNNING_SESSION_STATUS_VALUES.has(status))) return 'running';
  if (statuses.some((status) => DONE_SESSION_STATUS_VALUES.has(status))) return 'done';

  return undefined;
};

export const deriveTerminalSessionStatus = (value: unknown): TerminalSubagentStatus | undefined => {
  const statuses = collectSessionStatusValues(value);
  if (statuses.some((status) => ERROR_SESSION_STATUS_VALUES.has(status))) return 'error';
  if (statuses.some((status) => DONE_SESSION_STATUS_VALUES.has(status))) return 'done';

  return undefined;
};

export const deriveOpenCodeSessionStatus = deriveSessionStatus;
