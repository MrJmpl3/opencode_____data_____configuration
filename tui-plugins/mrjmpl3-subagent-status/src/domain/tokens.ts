import type { SubagentTokens } from './types.ts';

import { isPlainObject as isRecord, toFiniteNumber } from '@mrjmpl3/tui-kit';

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export const normalizeSubagentTokens = (input: unknown): SubagentTokens | undefined => {
  if (!isRecord(input)) return undefined;

  const tokens: SubagentTokens = {
    input: toFiniteNumber(input.input),
    output: toFiniteNumber(input.output),
    total: toFiniteNumber(input.total),
    contextPercent: toFiniteNumber(input.contextPercent),
  };

  if (
    tokens.input === undefined &&
    tokens.output === undefined &&
    tokens.total === undefined &&
    tokens.contextPercent === undefined
  ) {
    return undefined;
  }

  return tokens;
};

export const sameSubagentTokens = (left: SubagentTokens | undefined, right: SubagentTokens | undefined): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

export const mergeSubagentTokens = (
  existing: SubagentTokens | undefined,
  incoming: SubagentTokens | undefined,
): SubagentTokens | undefined => {
  if (!existing && !incoming) return undefined;

  return {
    input: incoming?.input ?? existing?.input,
    output: incoming?.output ?? existing?.output,
    total: incoming?.total ?? existing?.total,
    contextPercent: incoming?.contextPercent ?? existing?.contextPercent,
  };
};

export const resolveTokenTotal = (tokens: SubagentTokens | undefined): number | undefined => {
  const total = tokens?.total;
  if (isFiniteNumber(total)) {
    return total;
  }

  const input = tokens?.input;
  const output = tokens?.output;
  if (isFiniteNumber(input) || isFiniteNumber(output)) {
    return (input ?? 0) + (output ?? 0);
  }

  return undefined;
};

export const hasTokenUsage = (tokens: SubagentTokens | undefined): boolean => resolveTokenTotal(tokens) !== undefined;

export const hasContextUsage = (tokens: SubagentTokens | undefined): boolean => isFiniteNumber(tokens?.contextPercent);

export const hasCompleteUsageMetrics = (tokens: SubagentTokens | undefined): boolean =>
  hasTokenUsage(tokens) && hasContextUsage(tokens);
