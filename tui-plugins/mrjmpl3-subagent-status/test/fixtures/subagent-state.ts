import type { SubagentChild, SubagentState } from '../../src/domain/types.ts';

export const createChild = (
  overrides: Partial<SubagentChild> & Pick<SubagentChild, 'id' | 'title' | 'parentID'>,
): SubagentChild => {
  return {
    id: overrides.id,
    title: overrides.title,
    parentID: overrides.parentID,
    status: overrides.status ?? 'running',
    startedAt: overrides.startedAt ?? '2026-06-04T11:50:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-06-04T11:55:00.000Z',
    endedAt: overrides.endedAt,
    source: overrides.source,
    targetSessionID: overrides.targetSessionID,
    messageID: overrides.messageID,
    agentName: overrides.agentName,
    summary: overrides.summary,
    color: overrides.color,
    elapsedMs: overrides.elapsedMs,
    tokens: overrides.tokens,
  };
};

export const createState = (children: SubagentChild[], totalExecuted = children.length): SubagentState => {
  return {
    children: Object.fromEntries(children.map((child) => [child.id, child])),
    countedChildIDs: Object.fromEntries(children.map((child) => [child.id, true])),
    purgedSessionIDs: {},
    totalExecuted,
    updatedAt: '2026-06-04T12:00:00.000Z',
  };
};
