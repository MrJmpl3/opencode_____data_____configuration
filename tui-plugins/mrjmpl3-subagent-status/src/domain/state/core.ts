import type { SubagentCounts, SubagentState } from '../types.ts';

export const createEmptyState = (): SubagentState => ({
  children: {},
  countedChildIDs: {},
  purgedSessionIDs: {},
  totalExecuted: 0,
  updatedAt: new Date().toISOString(),
});

export const getCounts = (state: SubagentState): SubagentCounts => {
  const counts: SubagentCounts = { running: 0, done: 0, error: 0 };

  for (const child of Object.values(state.children)) {
    if (child.status === 'running') counts.running += 1;
    if (child.status === 'done') counts.done += 1;
    if (child.status === 'error') counts.error += 1;
  }

  return counts;
};
