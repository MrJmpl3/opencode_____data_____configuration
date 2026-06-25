import type { SubagentChild, SubagentTokens } from '../types.ts';

import { mergeSubagentTokens, normalizeSubagentTokens, sameSubagentTokens } from '../tokens.ts';
import { safeTimestamp, timestampMs, toFiniteNumber, toNonNegativeInteger } from '@mrjmpl3/tui-kit';

export const isTerminalStatus = (
  status: SubagentChild['status'],
): status is Exclude<SubagentChild['status'], 'running'> =>
  status === 'done' || status === 'error' || status === 'stale';

export const childEvidenceTimestampMs = (child: Pick<SubagentChild, 'startedAt' | 'updatedAt' | 'endedAt'>): number =>
  timestampMs(child.endedAt ?? child.updatedAt ?? child.startedAt);

export const sanitizeSummary = (value: unknown, title: string): string | undefined => {
  if (typeof value !== 'string') return undefined;

  const summary = value.replace(/\s+/g, ' ').trim();
  if (!summary) return undefined;
  if (summary.toLowerCase() === title.replace(/\s+/g, ' ').trim().toLowerCase()) return undefined;

  return summary;
};

export const sanitizeAgentName = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;

  const agentName = value
    .replace(/^\((.*)\)$/, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  return agentName || undefined;
};

export const sanitizeTargetSessionID = (value: unknown, fallback?: string): string | undefined => {
  if (typeof value === 'string' && value.startsWith('ses_')) return value;
  if (typeof fallback === 'string' && fallback.startsWith('ses_')) return fallback;
  return undefined;
};

export const sanitizeTokens = (input: unknown): SubagentTokens | undefined => normalizeSubagentTokens(input);

export const sameTokens = (left: SubagentTokens | undefined, right: SubagentTokens | undefined): boolean =>
  sameSubagentTokens(left, right);

export const mergeTokens = (
  existing: SubagentTokens | undefined,
  incoming: SubagentTokens | undefined,
): SubagentTokens | undefined => mergeSubagentTokens(existing, incoming);

export const resolveStatusColor = (status: SubagentChild['status']): NonNullable<SubagentChild['color']> => {
  if (status === 'done') return 'green';
  if (status === 'error') return 'red';
  if (status === 'stale') return 'gray';
  return 'yellow';
};

export const resolveElapsedMs = (
  child: Pick<SubagentChild, 'startedAt' | 'updatedAt' | 'endedAt' | 'status'>,
  nowMs: number,
): number => {
  const startedMs = Date.parse(child.startedAt);
  if (Number.isNaN(startedMs)) return 0;

  const endMs = child.status === 'running' ? nowMs : Date.parse(child.endedAt ?? child.updatedAt);
  if (Number.isNaN(endMs)) return 0;

  return Math.max(0, endMs - startedMs);
};

export const terminalChildTimestamp = (child: SubagentChild): number => {
  const parsed = Date.parse(child.endedAt ?? child.updatedAt ?? child.startedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
};

export { safeTimestamp, timestampMs, toFiniteNumber, toNonNegativeInteger };
