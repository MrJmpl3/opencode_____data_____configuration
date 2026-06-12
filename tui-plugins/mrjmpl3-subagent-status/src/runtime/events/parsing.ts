import type { SubagentState } from '../../domain/types.ts';

import { deriveOpenCodeSessionStatus } from '../../domain/session-status.ts';
import { conciseText, sameDisplayText } from '../../shared/display.ts';
import { asString, isRecord, timestampFromUnknown } from '../../shared/coercion.ts';
import type { EventLike } from '../boundaries/event-payload.ts';

export type SyntheticChild = {
  id: string;
  title: string;
  summary?: string;
  agentName?: string;
  parentID: string;
  messageID: string;
  targetSessionID?: string;
  startedAt?: string;
  updatedAt?: string;
  status?: 'running' | 'done' | 'error';
  endedAt?: string;
};

export type TaskToolEvidence = {
  status: 'running' | 'done' | 'error';
  targetSessionID?: string;
  endedAt?: string;
};

const firstDistinctSummary = (candidates: unknown[], title: string | undefined): string | undefined => {
  for (const candidate of candidates) {
    const summary = conciseText(candidate);
    if (summary && !sameDisplayText(summary, title)) return summary;
  }

  return undefined;
};

const isSessionId = (value: unknown): value is string => typeof value === 'string' && value.startsWith('ses_');

export const extractEventTimestamp = (event: EventLike, keys: string[]): string | undefined => {
  const part = isRecord(event.properties?.part) ? event.properties.part : undefined;
  const state = isRecord(part?.state) ? part.state : undefined;
  const sources = [
    isRecord(event.properties?.info?.time) ? event.properties.info.time : undefined,
    isRecord(part?.time) ? part.time : undefined,
    isRecord(state?.time) ? state.time : undefined,
    state,
    part,
  ];

  for (const source of sources) {
    if (!source) continue;
    for (const key of keys) {
      const candidate = timestampFromUnknown(source[key]);
      if (candidate) return candidate;
    }
  }

  return undefined;
};

export const extractSessionId = (event: EventLike): string | undefined =>
  asString(event.properties?.sessionID) ??
  asString(event.properties?.session_id) ??
  asString(event.properties?.sessionId) ??
  asString(event.properties?.info?.sessionID) ??
  asString(event.properties?.info?.session_id) ??
  asString(event.properties?.info?.sessionId) ??
  asString(event.sessionID) ??
  asString(event.session_id) ??
  asString(event.sessionId) ??
  asString(event.properties?.info?.id) ??
  asString(event.properties?.id);

export const extractOpenCodeEventSessionStatus = (event: EventLike): SyntheticChild['status'] | undefined => {
  const candidates = [
    event.properties?.info?.status,
    event.properties?.info?.state,
    event.properties?.status,
    event.properties?.state,
    event.status,
    event.state,
    event.properties,
  ];

  const statuses = candidates
    .map(deriveOpenCodeSessionStatus)
    .filter((status): status is SyntheticChild['status'] => Boolean(status) && status !== 'stale');

  return statuses.find((status) => status !== 'running') ?? statuses[0];
};

const collectSessionIds = (input: unknown, target: Set<string>, depth = 0): void => {
  if (depth > 4 || !input) return;

  if (isSessionId(input)) {
    target.add(input);
    return;
  }

  if (Array.isArray(input)) {
    for (const value of input) {
      collectSessionIds(value, target, depth + 1);
    }
    return;
  }

  if (!isRecord(input)) return;

  for (const [key, value] of Object.entries(input)) {
    if (!key.toLowerCase().includes('session')) continue;
    collectSessionIds(value, target, depth + 1);
  }
};

const extractPartTargetSessionCandidates = (event: EventLike): string[] => {
  const part = isRecord(event.properties?.part) ? event.properties.part : undefined;
  if (!part) return [];

  const candidates = new Set<string>();
  collectSessionIds(part, candidates);

  const parentSessionId = asString(part.sessionID) ?? asString(part.session_id) ?? extractSessionId(event);
  if (parentSessionId) candidates.delete(parentSessionId);

  return [...candidates];
};

const parseTaskSessionIdFromOutput = (value: unknown, parentSessionId?: string): string | undefined => {
  if (typeof value !== 'string') return undefined;

  const matches = [...value.matchAll(/\b(?:task_id\s*:\s*)?(ses_[A-Za-z0-9_-]+)\b/gi)];
  const candidates = new Set(matches.map((match) => match[1]));
  if (parentSessionId) candidates.delete(parentSessionId);

  return candidates.size === 1 ? [...candidates][0] : undefined;
};

export const resolveSyntheticTargetSessionID = (
  state: SubagentState,
  input: { parentID: string; messageID?: string },
  explicitCandidates: readonly string[] = [],
): string | undefined => {
  const candidates = new Set<string>(explicitCandidates.filter(isSessionId));
  const siblings = Object.values(state.children).filter(
    (child) => (child.source === 'session' || child.id.startsWith('ses_')) && child.parentID === input.parentID,
  );

  const byMessage = siblings.filter((child) => input.messageID && child.messageID === input.messageID);
  if (byMessage.length === 1) {
    candidates.add(byMessage[0].id);
  }

  if (siblings.length === 1) {
    candidates.add(siblings[0].id);
  }

  return candidates.size === 1 ? [...candidates][0] : undefined;
};

export const extractCreatedChild = (event: EventLike): SyntheticChild | null => {
  const info = event.properties?.info;
  const parentID = asString(info?.parentID);
  const id = asString(info?.id) ?? asString(event.properties?.id);
  if (!parentID || !id) return null;

  const startedAt = extractEventTimestamp(event, ['started', 'start', 'created', 'updated']);
  const updatedAt = extractEventTimestamp(event, ['updated', 'created', 'started', 'start']) ?? startedAt;
  const status = extractOpenCodeEventSessionStatus(event) ?? 'running';

  return {
    id,
    title: asString(info?.title) ?? asString(info?.name) ?? 'subagent',
    agentName: asString(info?.agent) ?? asString(info?.subagent_type),
    parentID,
    messageID: asString(info?.id) ?? id,
    targetSessionID: id,
    startedAt,
    updatedAt,
    status,
    endedAt:
      status === 'running'
        ? undefined
        : extractEventTimestamp(event, ['completed', 'end', 'ended', 'updated', 'created', 'started']),
  };
};

export const extractSubtaskChild = (event: EventLike): SyntheticChild | null => {
  const part = isRecord(event.properties?.part) ? event.properties.part : undefined;
  if (!part || part.type !== 'subtask') return null;

  const partID = asString(part.id);
  const parentID = asString(part.sessionID) ?? asString(part.session_id) ?? extractSessionId(event);
  const messageID = asString(part.messageID);
  if (!partID || !parentID || !messageID) return null;

  const title = asString(part.description) ?? asString(part.command) ?? asString(part.agent) ?? 'subtask';
  const state = isRecord(part.state) ? part.state : undefined;
  const input = isRecord(state?.input) ? state.input : undefined;
  const targetCandidates = extractPartTargetSessionCandidates(event);

  return {
    id: `subtask:${partID}`,
    title,
    summary: firstDistinctSummary([input?.prompt, input?.description, part.description, state?.description], title),
    agentName: asString(part.agent),
    parentID,
    messageID,
    targetSessionID: targetCandidates.length === 1 ? targetCandidates[0] : undefined,
    startedAt: extractEventTimestamp(event, ['started', 'start', 'created', 'updated']),
    updatedAt: extractEventTimestamp(event, ['updated', 'created', 'started', 'start']),
    status: 'running',
  };
};

export const extractTaskToolEvidence = (event: EventLike): TaskToolEvidence | null => {
  const part = isRecord(event.properties?.part) ? event.properties.part : undefined;
  if (!part || part.type !== 'tool' || asString(part.tool) !== 'task') return null;

  const state = isRecord(part.state) ? part.state : undefined;
  if (!state) return null;

  const rawStatus = asString(state.status);
  const status: TaskToolEvidence['status'] = rawStatus === 'error' ? 'error' : 'running';

  const metadata = isRecord(state.metadata) ? state.metadata : undefined;
  const parentSessionId = asString(part.sessionID) ?? asString(part.session_id) ?? extractSessionId(event);
  const targetFromOutput = parseTaskSessionIdFromOutput(state.output, parentSessionId);
  const targetCandidates = extractPartTargetSessionCandidates(event);
  const targetSessionID =
    asString(metadata?.sessionId) ??
    asString(metadata?.sessionID) ??
    asString(metadata?.session_id) ??
    targetFromOutput ??
    (targetCandidates.length === 1 ? targetCandidates[0] : undefined);

  return {
    status,
    targetSessionID,
    endedAt: status === 'error' ? extractEventTimestamp(event, ['completed', 'end', 'ended', 'updated']) : undefined,
  };
};

export const extractToolChild = (event: EventLike): SyntheticChild | null => {
  const part = isRecord(event.properties?.part) ? event.properties.part : undefined;
  if (!part || part.type !== 'tool') return null;

  const tool = asString(part.tool);
  if (tool !== 'delegate' && tool !== 'task') return null;

  const partID = asString(part.id);
  const parentID = asString(part.sessionID) ?? asString(part.session_id) ?? extractSessionId(event);
  const messageID = asString(part.messageID);
  const state = isRecord(part.state) ? part.state : undefined;
  if (!partID || !parentID || !messageID || !state) return null;

  const input = isRecord(state.input) ? state.input : undefined;
  const title =
    asString(state.title) ??
    asString(input?.description) ??
    conciseText(input?.prompt) ??
    asString(part.description) ??
    asString(input?.subagent_type) ??
    tool;
  const evidence = extractTaskToolEvidence(event);
  const targetCandidates = extractPartTargetSessionCandidates(event);
  const status = evidence?.status ?? (asString(state.status) === 'error' ? 'error' : 'running');

  return {
    id: `tool:${partID}`,
    title,
    summary: firstDistinctSummary([input?.prompt, input?.description, part.description, state.description], title),
    agentName: asString(input?.subagent_type) ?? asString(input?.agent),
    parentID,
    messageID,
    targetSessionID: evidence?.targetSessionID ?? (targetCandidates.length === 1 ? targetCandidates[0] : undefined),
    startedAt: extractEventTimestamp(event, ['started', 'start', 'created', 'updated']),
    updatedAt: extractEventTimestamp(event, ['updated', 'completed', 'created', 'started', 'start']),
    endedAt: evidence?.endedAt,
    status,
  };
};

export const extractChildDetails = (
  event: EventLike,
): {
  title?: string;
  summary?: string;
  agentName?: string;
  updatedAt?: string;
} => {
  const part = isRecord(event.properties?.part) ? event.properties.part : undefined;
  const state = isRecord(part?.state) ? part.state : undefined;
  const input = isRecord(state?.input) ? state.input : undefined;

  return {
    title:
      asString(event.properties?.info?.title) ??
      asString(event.properties?.title) ??
      asString(event.title) ??
      asString(event.name),
    summary: firstDistinctSummary(
      [input?.prompt, input?.description, part?.description, state?.description],
      undefined,
    ),
    agentName:
      asString(input?.subagent_type) ??
      asString(input?.agent) ??
      asString(part?.agent) ??
      asString(event.properties?.info?.agent) ??
      asString(event.properties?.info?.subagent_type),
    updatedAt: extractEventTimestamp(event, ['updated', 'completed', 'created', 'started', 'start']),
  };
};

export const mapTaskToolToSubtaskID = (
  state: SubagentState,
  task: {
    parentID: string;
    messageID: string;
    title: string;
    summary?: string;
    agentName?: string;
    targetSessionID?: string;
  },
): string | undefined => {
  const candidates = Object.values(state.children).filter(
    (child) => child.source === 'subtask' && child.status === 'running' && child.parentID === task.parentID,
  );
  const byMessage = candidates.filter((child) => child.messageID === task.messageID);
  const scoped = byMessage.length > 0 ? byMessage : candidates;
  if (scoped.length === 0) return undefined;

  if (task.targetSessionID) {
    const byTarget = scoped.filter((child) => child.targetSessionID === task.targetSessionID);
    if (byTarget.length === 1) return byTarget[0].id;
  }

  const byTitle = scoped.filter((child) => sameDisplayText(child.title, task.title));
  if (byTitle.length === 1) return byTitle[0].id;

  const bySummary = scoped.filter((child) => sameDisplayText(child.summary, task.summary));
  if (bySummary.length === 1) return bySummary[0].id;

  const byAgent = task.agentName ? scoped.filter((child) => sameDisplayText(child.agentName, task.agentName)) : [];
  if (byAgent.length === 1) return byAgent[0].id;

  return undefined;
};
