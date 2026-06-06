import type { SubagentChild } from '../domain/types.ts';

import { resolveChildSessionID } from './session-target.ts';

type SessionRowLike = Pick<SubagentChild, 'id'> & Partial<Pick<SubagentChild, 'source' | 'targetSessionID'>>;

export function isRealSessionRow(child: SessionRowLike): boolean {
  return child.source === 'session' || child.id.startsWith('ses_');
}

export function resolveSessionRowSessionID(child: SessionRowLike): string | undefined {
  return resolveChildSessionID(child);
}
