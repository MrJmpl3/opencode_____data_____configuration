import type { SubagentTokens } from './types.ts';

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function resolveTokenTotal(tokens: SubagentTokens | undefined): number | undefined {
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
}

export function hasTokenUsage(tokens: SubagentTokens | undefined): boolean {
  return resolveTokenTotal(tokens) !== undefined;
}

export function hasContextUsage(tokens: SubagentTokens | undefined): boolean {
  return isFiniteNumber(tokens?.contextPercent);
}

export function hasCompleteUsageMetrics(tokens: SubagentTokens | undefined): boolean {
  return hasTokenUsage(tokens) && hasContextUsage(tokens);
}
