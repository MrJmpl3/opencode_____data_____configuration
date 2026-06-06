import type { SubagentChild } from '../types.ts';

import {
  resolveElapsedMs,
  resolveStatusColor,
  safeTimestamp,
  sanitizeAgentName,
  sanitizeSummary,
  sanitizeTargetSessionID,
  sanitizeTokens,
} from './helpers.ts';

export const normalizeChild = (child: SubagentChild, nowMs = Date.now()): SubagentChild => {
  const now = new Date(nowMs).toISOString();
  const status =
    child.status === 'done' || child.status === 'error' || child.status === 'running' ? child.status : 'running';
  const title = typeof child.title === 'string' && child.title.trim().length > 0 ? child.title : child.id;
  const startedAt = safeTimestamp(child.startedAt, now);
  const updatedAt = safeTimestamp(child.updatedAt, startedAt);
  const endedAt = child.endedAt ? safeTimestamp(child.endedAt, updatedAt) : undefined;

  return {
    ...child,
    title,
    summary: sanitizeSummary(child.summary, title),
    agentName: sanitizeAgentName(child.agentName),
    targetSessionID: sanitizeTargetSessionID(child.targetSessionID, child.id.startsWith('ses_') ? child.id : undefined),
    status,
    color: resolveStatusColor(status),
    startedAt,
    updatedAt,
    endedAt,
    elapsedMs: resolveElapsedMs({ startedAt, updatedAt, endedAt, status }, nowMs),
    tokens: sanitizeTokens(child.tokens),
  };
};
