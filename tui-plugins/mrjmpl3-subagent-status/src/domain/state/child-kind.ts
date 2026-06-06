import type { SubagentChild } from '../types.ts';

export const isRealSessionChild = (
  child: Pick<SubagentChild, 'id'> & Partial<Pick<SubagentChild, 'source'>>,
): boolean => child.source === 'session' || child.id.startsWith('ses_');

export const isSyntheticToolWrapper = (child: Partial<Pick<SubagentChild, 'source'>>): boolean =>
  child.source === 'tool';

export const isDelegationLikeChild = (child: Pick<SubagentChild, 'title'>): boolean =>
  child.title.trim().toLowerCase().startsWith('delegation:');

export const isSubtaskFallback = (child: Partial<Pick<SubagentChild, 'source'>>): boolean => child.source === 'subtask';
