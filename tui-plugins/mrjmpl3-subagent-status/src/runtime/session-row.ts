import type { SubagentChild } from '../domain/types.ts';

import { resolveChildSessionId } from './session-target.ts';

type SessionRowLike = Pick<SubagentChild, 'id'> & Partial<Pick<SubagentChild, 'source' | 'targetSessionID'>>;

export function isRealSessionRow(child: SessionRowLike): boolean {
  return child.source === 'session' || child.id.startsWith('ses_');
}

export function resolveSessionRowSessionId(child: SessionRowLike): string | undefined {
  return resolveChildSessionId(child);
}
