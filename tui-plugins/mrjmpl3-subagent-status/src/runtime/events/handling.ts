import { deriveOpenCodeSessionStatus } from '../../domain/session-status.ts';
import { markChildRunning, markChildStatus, upsertChildDetails, upsertRunningChild } from '../../domain/state.ts';
import type { SubagentState } from '../../domain/types.ts';

import {
  extractChildDetails,
  extractCreatedChild,
  extractEventTimestamp,
  extractSessionId,
  extractSubtaskChild,
  extractToolChild,
  mapTaskToolToSubtaskID,
  resolveSyntheticTargetSessionID,
} from './parsing.ts';
import { asString } from '../../shared/coercion.ts';
import { normalizeEventPayload, type EventLike } from '../boundaries/event-payload.ts';

const handleSessionCreated = (state: SubagentState, event: EventLike): boolean => {
  const created = extractCreatedChild(event);
  if (!created) return false;

  return upsertRunningChild(
    state,
    {
      ...created,
      source: 'session',
      targetSessionID: created.id,
    },
    { allowTerminalReopen: true },
  );
};

const handleSessionIdle = (state: SubagentState, event: EventLike): boolean => {
  const sessionId = extractSessionId(event);
  if (!sessionId) return false;

  return upsertChildDetails(state, sessionId, extractChildDetails(event));
};

const handleSessionStatus = (state: SubagentState, event: EventLike): boolean => {
  const type = asString(event.type);
  const sessionId = extractSessionId(event);
  if (!type || !sessionId) return false;

  const status =
    type === 'session.error'
      ? 'error'
      : deriveOpenCodeSessionStatus(
          event.properties?.status ??
            event.properties?.state ??
            event.properties?.info?.status ??
            event.status ??
            event.state ??
            event.properties,
        );
  if (!status) return false;

  const details = extractChildDetails(event);
  const eventUpdatedAt = details.updatedAt;
  const changed =
    status === 'running'
      ? markChildRunning(state, sessionId, eventUpdatedAt)
      : markChildStatus(
          state,
          sessionId,
          status,
          extractEventTimestamp(event, ['completed', 'end', 'ended', 'updated', 'created', 'started']),
        );

  return upsertChildDetails(state, sessionId, details) || changed;
};

const handleMessagePartUpdated = (state: SubagentState, event: EventLike): boolean => {
  let changed = false;

  const subtask = extractSubtaskChild(event);
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

  const tool = extractToolChild(event);
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

  if (asString(event.properties?.part?.tool) !== 'task' || (tool.status !== 'done' && tool.status !== 'error')) {
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
};

export const applySubagentEvent = (state: SubagentState, event: unknown): boolean => {
  const candidate = normalizeEventPayload(event);
  if (!candidate) return false;

  const type = asString(candidate.type);
  if (!type) return false;

  if (type === 'session.created' || type === 'session.updated') return handleSessionCreated(state, candidate);
  if (type === 'session.idle') return handleSessionIdle(state, candidate);
  if (type === 'session.error' || type === 'session.status') return handleSessionStatus(state, candidate);
  if (type !== 'message.part.updated') return false;

  return handleMessagePartUpdated(state, candidate);
};
