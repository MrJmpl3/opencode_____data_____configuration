import type { SubagentChild } from '../../domain/types.ts';

export const byPriority = (left: SubagentChild, right: SubagentChild): number => {
  const startedDiff = right.startedAt.localeCompare(left.startedAt);
  if (startedDiff !== 0) return startedDiff;

  return left.id.localeCompare(right.id);
};

export const formatAggregateNumber = (value: number): string => Math.max(0, Math.round(value)).toLocaleString('en-US');
