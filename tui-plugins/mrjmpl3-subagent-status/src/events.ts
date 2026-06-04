import type { TuiPluginApi } from '@opencode-ai/plugin/tui';

import { deriveOpenCodeSessionStatus } from './reconcile.ts';
import { markChildStatus, upsertChildDetails, upsertRunningChild } from './state.ts';
import type { SubagentState } from './types.ts';

const RELEVANT_EVENTS = new Set([
  'tui.session.select',
  'session.created',
  'session.updated',
  'session.idle',
  'session.error',
  'session.status',
  'message.part.updated',
  'message.updated',
]);

type EventLike = {
  type?: unknown;
  title?: unknown;
  name?: unknown;
  sessionID?: unknown;
  sessionId?: unknown;
  status?: unknown;
  state?: unknown;
  parentID?: unknown;
  properties?: {
    id?: unknown;
    sessionID?: unknown;
    sessionId?: unknown;
    title?: unknown;
    name?: unknown;
    parentID?: unknown;
    status?: unknown;
    state?: unknown;
    info?: {
      id?: unknown;
      title?: unknown;
      name?: unknown;
      agent?: unknown;
      subagent_type?: unknown;
      sessionID?: unknown;
      sessionId?: unknown;
      parentID?: unknown;
      status?: unknown;
      state?: unknown;
      time?: Record<string, unknown>;
    };
    part?: Record<string, unknown>;
  };
  [key: string]: unknown;
};

type SyntheticChild = {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function conciseText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > 180 ? `${text.slice(0, 179)}…` : text;
}

function sameDisplayText(left?: string, right?: string): boolean {
  if (!left || !right) return false;
  return left.replace(/\s+/g, ' ').trim().toLowerCase() === right.replace(/\s+/g, ' ').trim().toLowerCase();
}

function firstDistinctSummary(candidates: unknown[], title: string | undefined): string | undefined {
  for (const candidate of candidates) {
    const summary = conciseText(candidate);
    if (summary && !sameDisplayText(summary, title)) return summary;
  }

  return undefined;
}

function isSessionID(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('ses_');
}

function toIsoTimestamp(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
  }

  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const millis = value < 10_000_000_000 ? value * 1000 : value;
    const parsed = new Date(millis);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }

  return undefined;
}

function extractEventTimestamp(event: EventLike, keys: string[]): string | undefined {
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
      const candidate = toIsoTimestamp(source[key]);
      if (candidate) return candidate;
    }
  }

  return undefined;
}

export function extractSessionID(event: EventLike): string | undefined {
  return (
    asString(event.properties?.sessionID) ??
    asString(event.properties?.sessionId) ??
    asString(event.properties?.info?.sessionID) ??
    asString(event.properties?.info?.sessionId) ??
    asString(event.sessionID) ??
    asString(event.sessionId) ??
    asString(event.properties?.info?.id) ??
    asString(event.properties?.id)
  );
}

function collectSessionIDs(input: unknown, target: Set<string>, depth = 0): void {
  if (depth > 4 || !input) return;

  if (isSessionID(input)) {
    target.add(input);
    return;
  }

  if (Array.isArray(input)) {
    for (const value of input) {
      collectSessionIDs(value, target, depth + 1);
    }
    return;
  }

  if (!isRecord(input)) return;

  for (const [key, value] of Object.entries(input)) {
    if (!key.toLowerCase().includes('session')) continue;
    collectSessionIDs(value, target, depth + 1);
  }
}

function extractPartTargetSessionCandidates(event: EventLike): string[] {
  const part = isRecord(event.properties?.part) ? event.properties.part : undefined;
  if (!part) return [];

  const candidates = new Set<string>();
  collectSessionIDs(part, candidates);

  const parentSessionID = asString(part.sessionID) ?? extractSessionID(event);
  if (parentSessionID) candidates.delete(parentSessionID);

  return [...candidates];
}

function parseTaskSessionIDFromOutput(value: unknown, parentSessionID?: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  const matches = [...value.matchAll(/\b(?:task_id\s*:\s*)?(ses_[A-Za-z0-9_-]+)\b/gi)];
  const candidates = new Set(matches.map((match) => match[1]));
  if (parentSessionID) candidates.delete(parentSessionID);
  return candidates.size === 1 ? [...candidates][0] : undefined;
}

function resolveSyntheticTargetSessionID(
  state: SubagentState,
  input: { parentID: string; messageID?: string },
  explicitCandidates: readonly string[] = [],
): string | undefined {
  const candidates = new Set<string>(explicitCandidates.filter(isSessionID));
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
}

function extractCreatedChild(event: EventLike): SyntheticChild | null {
  const info = event.properties?.info;
  const parentID = asString(info?.parentID);
  const id = asString(info?.id) ?? asString(event.properties?.id);
  if (!parentID || !id) return null;

  const startedAt = extractEventTimestamp(event, ['started', 'start', 'created', 'updated']);
  const updatedAt = extractEventTimestamp(event, ['updated', 'created', 'started', 'start']) ?? startedAt;

  return {
    id,
    title: asString(info?.title) ?? asString(info?.name) ?? 'subagent',
    agentName: asString(info?.agent) ?? asString(info?.subagent_type),
    parentID,
    messageID: asString(info?.id) ?? id,
    targetSessionID: id,
    startedAt,
    updatedAt,
    status: 'running',
  };
}

function extractSubtaskChild(event: EventLike): SyntheticChild | null {
  const part = isRecord(event.properties?.part) ? event.properties.part : undefined;
  if (!part || part.type !== 'subtask') return null;

  const partID = asString(part.id);
  const parentID = asString(part.sessionID) ?? extractSessionID(event);
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
}

export function extractTaskToolEvidence(event: EventLike): TaskToolEvidence | null {
  const part = isRecord(event.properties?.part) ? event.properties.part : undefined;
  if (!part || part.type !== 'tool' || asString(part.tool) !== 'task') return null;

  const state = isRecord(part.state) ? part.state : undefined;
  if (!state) return null;

  const rawStatus = asString(state.status);
  const status: TaskToolEvidence['status'] =
    rawStatus === 'completed' ? 'done' : rawStatus === 'error' ? 'error' : 'running';

  const metadata = isRecord(state.metadata) ? state.metadata : undefined;
  const parentSessionID = asString(part.sessionID) ?? extractSessionID(event);
  const targetFromOutput = parseTaskSessionIDFromOutput(state.output, parentSessionID);
  const targetCandidates = extractPartTargetSessionCandidates(event);
  const targetSessionID =
    asString(metadata?.sessionId) ??
    asString(metadata?.sessionID) ??
    targetFromOutput ??
    (targetCandidates.length === 1 ? targetCandidates[0] : undefined);

  return {
    status,
    targetSessionID,
    endedAt:
      status === 'done' || status === 'error'
        ? extractEventTimestamp(event, ['completed', 'end', 'ended', 'updated'])
        : undefined,
  };
}

function extractToolChild(event: EventLike): SyntheticChild | null {
  const part = isRecord(event.properties?.part) ? event.properties.part : undefined;
  if (!part || part.type !== 'tool') return null;

  const tool = asString(part.tool);
  if (tool !== 'delegate' && tool !== 'task') return null;

  const partID = asString(part.id);
  const parentID = asString(part.sessionID) ?? extractSessionID(event);
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
  const status =
    evidence?.status ??
    (asString(state.status) === 'error' ? 'error' : asString(state.status) === 'completed' ? 'done' : 'running');

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
}

function extractChildDetails(event: EventLike): {
  title?: string;
  summary?: string;
  agentName?: string;
  updatedAt?: string;
} {
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
}

function mapTaskToolToSubtaskID(
  state: SubagentState,
  task: {
    parentID: string;
    messageID: string;
    title: string;
    summary?: string;
    agentName?: string;
    targetSessionID?: string;
  },
): string | undefined {
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

  return scoped.length === 1 ? scoped[0].id : undefined;
}

export function installEventBridge(
  api: Pick<TuiPluginApi, 'event' | 'lifecycle'>,
  refresh: () => Promise<void>,
  onEvent?: (event: unknown) => void,
): () => void {
  const unsubs: Array<() => void> = [];

  for (const eventName of RELEVANT_EVENTS) {
    unsubs.push(
      api.event.on(eventName as never, (event) => {
        onEvent?.(event);
        void refresh();
      }),
    );
  }

  const dispose = () => {
    for (const unsub of unsubs) {
      try {
        unsub();
      } catch {
        // Best effort cleanup.
      }
    }
  };

  api.lifecycle.onDispose(dispose);
  return dispose;
}

export function applySubagentEvent(state: SubagentState, event: unknown): boolean {
  const candidate = (event ?? {}) as EventLike;
  const type = asString(candidate.type);
  if (!type) return false;

  if (type === 'session.created' || type === 'session.updated') {
    const created = extractCreatedChild(candidate);
    if (!created) return false;
    return upsertRunningChild(state, {
      ...created,
      source: 'session',
      targetSessionID: created.id,
    });
  }

  if (type === 'session.idle' || type === 'session.error' || type === 'session.status') {
    const sessionID = extractSessionID(candidate);
    if (!sessionID) return false;

    const status =
      type === 'session.idle'
        ? 'done'
        : type === 'session.error'
          ? 'error'
          : deriveOpenCodeSessionStatus(
              candidate.properties?.status ??
                candidate.properties?.state ??
                candidate.properties?.info?.status ??
                candidate.status ??
                candidate.state ??
                candidate.properties,
            );
    if (!status) return false;

    let changed = false;
    if (status !== 'running') {
      changed =
        markChildStatus(
          state,
          sessionID,
          status,
          extractEventTimestamp(candidate, ['completed', 'end', 'ended', 'updated']),
        ) || changed;
    }

    return upsertChildDetails(state, sessionID, extractChildDetails(candidate)) || changed;
  }

  if (type !== 'message.part.updated') return false;

  let changed = false;
  const subtask = extractSubtaskChild(candidate);
  if (subtask) {
    changed =
      upsertRunningChild(state, {
        ...subtask,
        source: 'subtask',
        targetSessionID: resolveSyntheticTargetSessionID(
          state,
          { parentID: subtask.parentID, messageID: subtask.messageID },
          subtask.targetSessionID ? [subtask.targetSessionID] : [],
        ),
      }) || changed;
  }

  const tool = extractToolChild(candidate);
  if (!tool) return changed;

  const targetSessionID = resolveSyntheticTargetSessionID(
    state,
    { parentID: tool.parentID, messageID: tool.messageID },
    tool.targetSessionID ? [tool.targetSessionID] : [],
  );

  changed =
    upsertRunningChild(state, {
      ...tool,
      source: 'tool',
      targetSessionID,
    }) || changed;

  if (tool.status === 'done' || tool.status === 'error') {
    changed = markChildStatus(state, tool.id, tool.status, tool.endedAt ?? tool.updatedAt) || changed;
  }

  if (asString(candidate.properties?.part?.tool) !== 'task' || (tool.status !== 'done' && tool.status !== 'error')) {
    return changed;
  }

  const subtaskID = mapTaskToolToSubtaskID(state, {
    parentID: tool.parentID,
    messageID: tool.messageID,
    title: tool.title,
    summary: tool.summary,
    agentName: tool.agentName,
    targetSessionID,
  });
  if (!subtaskID) return changed;

  if (targetSessionID) {
    changed = upsertChildDetails(state, subtaskID, { targetSessionID, updatedAt: tool.updatedAt }) || changed;
  }

  return markChildStatus(state, subtaskID, tool.status, tool.endedAt ?? tool.updatedAt) || changed;
}
