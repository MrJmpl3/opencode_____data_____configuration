import { describe, expect, it } from 'vitest';

import { applySubagentEvent, extractTaskToolEvidence } from '../src/runtime/events.ts';
import { createEmptyState } from '../src/domain/state.ts';

const CREATED_AT = '2026-06-05T10:00:00.000Z';
const IDLE_AT = '2026-06-05T10:01:00.000Z';
const DONE_AT = '2026-06-05T10:02:00.000Z';
const ERROR_AT = '2026-06-05T10:03:00.000Z';

function seedChildSession() {
  const state = createEmptyState();

  expect(
    applySubagentEvent(state, {
      type: 'session.created',
      properties: {
        info: {
          id: 'ses_child',
          parentID: 'ses_parent',
          title: 'Delegated child',
          time: {
            created: CREATED_AT,
          },
        },
      },
    }),
  ).toBe(true);

  return state;
}

describe('events', () => {
  it('parses subtask events and keeps completed task tool evidence non-terminal', () => {
    const state = createEmptyState();

    expect(
      applySubagentEvent(state, {
        type: 'message.part.updated',
        properties: {
          sessionID: 'ses_parent',
          part: {
            type: 'subtask',
            id: 'part_1',
            sessionID: 'ses_parent',
            messageID: 'msg_1',
            description: 'Review auth changes',
            state: {
              input: {
                prompt: 'Review auth changes and report findings',
              },
            },
            targetSession: 'ses_child_1',
          },
        },
      }),
    ).toBe(true);

    expect(state.children['subtask:part_1']).toMatchObject({
      id: 'subtask:part_1',
      source: 'subtask',
      title: 'Review auth changes',
      targetSessionID: 'ses_child_1',
      status: 'running',
    });

    const evidence = extractTaskToolEvidence({
      type: 'message.part.updated',
      properties: {
        part: {
          type: 'tool',
          tool: 'task',
          state: {
            status: 'completed',
            metadata: { sessionId: 'ses_child_1' },
            time: { end: '2026-06-04T12:05:00.000Z' },
          },
        },
      },
    });

    expect(evidence).toMatchObject({
      status: 'running',
      targetSessionID: 'ses_child_1',
    });
    expect(evidence?.endedAt).toBeUndefined();
  });

  it('ignores ambiguous task target evidence', () => {
    expect(
      extractTaskToolEvidence({
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            tool: 'task',
            state: {
              status: 'completed',
              output: 'first ses_child_1 then ses_child_2',
            },
          },
        },
      })?.targetSessionID,
    ).toBeUndefined();
  });

  it('keeps matching tool and subtask rows running until the delegated session finishes', () => {
    const state = createEmptyState();

    applySubagentEvent(state, {
      type: 'message.part.updated',
      properties: {
        sessionID: 'ses_parent',
        part: {
          type: 'subtask',
          id: 'part_1',
          sessionID: 'ses_parent',
          messageID: 'msg_1',
          description: 'Execute migration slice',
          targetSession: 'ses_child_1',
        },
      },
    });

    expect(
      applySubagentEvent(state, {
        type: 'message.part.updated',
        properties: {
          sessionID: 'ses_parent',
          part: {
            type: 'tool',
            tool: 'task',
            id: 'tool_1',
            sessionID: 'ses_parent',
            messageID: 'msg_1',
            state: {
              status: 'completed',
              input: { description: 'Execute migration slice' },
              metadata: { sessionId: 'ses_child_1' },
              time: { end: '2026-06-04T12:10:00.000Z' },
            },
          },
        },
      }),
    ).toBe(true);

    expect(state.children['tool:tool_1']).toMatchObject({
      status: 'running',
      targetSessionID: 'ses_child_1',
    });
    expect(state.children['subtask:part_1']).toMatchObject({
      status: 'running',
      targetSessionID: 'ses_child_1',
    });
    expect(state.children['tool:tool_1']?.endedAt).toBeUndefined();
    expect(state.children['subtask:part_1']?.endedAt).toBeUndefined();
  });

  it('does not mark the only running subtask as failed when task tool evidence cannot be correlated', () => {
    const state = createEmptyState();

    applySubagentEvent(state, {
      type: 'message.part.updated',
      properties: {
        sessionID: 'ses_parent',
        part: {
          type: 'subtask',
          id: 'part_1',
          sessionID: 'ses_parent',
          messageID: 'msg_1',
          description: 'Execute migration slice',
        },
      },
    });

    expect(
      applySubagentEvent(state, {
        type: 'message.part.updated',
        properties: {
          sessionID: 'ses_parent',
          part: {
            type: 'tool',
            tool: 'task',
            id: 'tool_1',
            sessionID: 'ses_parent',
            messageID: 'msg_2',
            state: {
              status: 'error',
              input: { description: 'Different delegated task' },
              time: { end: '2026-06-04T12:10:00.000Z' },
            },
          },
        },
      }),
    ).toBe(true);

    expect(state.children['tool:tool_1']).toMatchObject({
      status: 'error',
      endedAt: '2026-06-04T12:10:00.000Z',
    });
    expect(state.children['subtask:part_1']).toMatchObject({
      status: 'running',
      endedAt: undefined,
    });
  });

  it('keeps an existing child running when only session.idle arrives', () => {
    const state = seedChildSession();

    applySubagentEvent(state, {
      type: 'session.idle',
      properties: {
        sessionID: 'ses_child',
        title: 'Delegated child',
        info: {
          time: {
            updated: IDLE_AT,
          },
        },
      },
    });

    expect(state.children.ses_child).toMatchObject({
      status: 'running',
      updatedAt: CREATED_AT,
    });
    expect(state.children.ses_child?.endedAt).toBeUndefined();
  });

  it('marks an idle child done only after explicit session.status completion evidence arrives', () => {
    const state = seedChildSession();

    applySubagentEvent(state, {
      type: 'session.idle',
      properties: {
        sessionID: 'ses_child',
        info: {
          time: {
            updated: IDLE_AT,
          },
        },
      },
    });

    expect(
      applySubagentEvent(state, {
        type: 'session.status',
        properties: {
          sessionID: 'ses_child',
          status: 'completed',
          info: {
            time: {
              completed: DONE_AT,
            },
          },
        },
      }),
    ).toBe(true);

    expect(state.children.ses_child).toMatchObject({
      status: 'done',
      updatedAt: DONE_AT,
      endedAt: DONE_AT,
    });
  });

  it('marks an idle child error when later session.error evidence arrives', () => {
    const state = seedChildSession();

    applySubagentEvent(state, {
      type: 'session.idle',
      properties: {
        sessionID: 'ses_child',
        info: {
          time: {
            updated: IDLE_AT,
          },
        },
      },
    });

    expect(
      applySubagentEvent(state, {
        type: 'session.error',
        properties: {
          sessionID: 'ses_child',
          info: {
            time: {
              ended: ERROR_AT,
            },
          },
        },
      }),
    ).toBe(true);

    expect(state.children.ses_child).toMatchObject({
      status: 'error',
      updatedAt: ERROR_AT,
      endedAt: ERROR_AT,
    });
  });

  it('reopens a done child when explicit session.status running evidence arrives', () => {
    const state = seedChildSession();
    state.children.ses_child.status = 'done';
    state.children.ses_child.color = 'green';
    state.children.ses_child.updatedAt = DONE_AT;
    state.children.ses_child.endedAt = DONE_AT;
    state.children['tool:ses_child'] = {
      id: 'tool:ses_child',
      title: 'Delegated child',
      parentID: 'ses_parent',
      source: 'tool',
      targetSessionID: 'ses_child',
      status: 'done',
      color: 'green',
      startedAt: CREATED_AT,
      updatedAt: DONE_AT,
      endedAt: DONE_AT,
    };

    expect(
      applySubagentEvent(state, {
        type: 'session.status',
        properties: {
          sessionID: 'ses_child',
          status: 'running',
          info: {
            time: {
              updated: '2026-06-05T10:05:00.000Z',
            },
          },
        },
      }),
    ).toBe(true);

    expect(state.children.ses_child).toMatchObject({
      status: 'running',
      color: 'yellow',
      updatedAt: '2026-06-05T10:05:00.000Z',
      endedAt: undefined,
    });
    expect(state.children['tool:ses_child']).toMatchObject({
      status: 'running',
      color: 'yellow',
      updatedAt: '2026-06-05T10:05:00.000Z',
      endedAt: undefined,
    });
  });

  it('does not reopen a terminal child from stale session.status running evidence', () => {
    const state = seedChildSession();
    state.children.ses_child.status = 'error';
    state.children.ses_child.color = 'red';
    state.children.ses_child.updatedAt = ERROR_AT;
    state.children.ses_child.endedAt = ERROR_AT;

    expect(
      applySubagentEvent(state, {
        type: 'session.status',
        properties: {
          sessionID: 'ses_child',
          status: 'running',
          info: {
            time: {
              updated: IDLE_AT,
            },
          },
        },
      }),
    ).toBe(false);

    expect(state.children.ses_child).toMatchObject({
      status: 'error',
      color: 'red',
      updatedAt: ERROR_AT,
      endedAt: ERROR_AT,
    });
  });
});
