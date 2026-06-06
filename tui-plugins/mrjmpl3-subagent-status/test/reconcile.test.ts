import { describe, expect, it } from 'vitest';

import { normalizeChildrenResponse, reconcileChildrenState } from '../src/domain/reconcile.ts';
import { createEmptyState } from '../src/domain/state.ts';

describe('reconcile', () => {
  it('normalizes session children responses', () => {
    const children = normalizeChildrenResponse({
      data: [
        {
          id: 'ses_1',
          parentID: 'ses_parent',
          title: 'Runner',
          status: 'done',
          startedAt: '2026-06-04T00:00:00.000Z',
          updatedAt: '2026-06-04T00:01:00.000Z',
          tokens: { total: 123 },
        },
      ],
    });

    expect(children).toHaveLength(1);
    expect(children[0]?.status).toBe('done');
    expect(children[0]?.tokens?.total).toBe(123);
  });

  it('uses session time fields without terminalizing idle snapshots', () => {
    const children = normalizeChildrenResponse({
      data: [
        {
          id: 'ses_2',
          parentID: 'ses_parent',
          title: 'Timed runner',
          status: 'idle',
          time: {
            created: 1717502400,
            updated: 1717502460,
          },
        },
      ],
    });

    expect(children[0]?.startedAt).toBe('2024-06-04T12:00:00.000Z');
    expect(children[0]?.updatedAt).toBe('2024-06-04T12:01:00.000Z');
    expect(children[0]?.endedAt).toBeUndefined();
    expect(children[0]?.status).toBe('running');
  });

  it('reconciles child snapshots without rewriting identical state', () => {
    const initial = createEmptyState();

    const first = reconcileChildrenState(initial, {
      data: [
        {
          id: 'ses_1',
          parentID: 'ses_parent',
          title: 'Runner',
          status: 'running',
          startedAt: '2026-06-04T00:00:00.000Z',
          updatedAt: '2026-06-04T00:00:00.000Z',
        },
      ],
    });

    expect(first.changed).toBe(true);
    expect(first.nextState.totalExecuted).toBe(1);

    const second = reconcileChildrenState(first.nextState, {
      data: [
        {
          id: 'ses_1',
          parentID: 'ses_parent',
          title: 'Runner',
          status: 'running',
          startedAt: '2026-06-04T00:00:00.000Z',
          updatedAt: '2026-06-04T00:00:00.000Z',
        },
      ],
    });

    expect(second.changed).toBe(false);
    expect(second.nextState.totalExecuted).toBe(1);
  });

  it('rekeys a counted fallback subtask when the real session appears', () => {
    const initial = createEmptyState();

    const first = reconcileChildrenState(initial, {
      data: [
        {
          id: 'subtask:part_1',
          parentID: 'ses_parent',
          messageID: 'msg_1',
          title: 'Fallback work',
          source: 'subtask',
          status: 'running',
          startedAt: '2026-06-04T00:00:00.000Z',
          updatedAt: '2026-06-04T00:00:00.000Z',
        },
      ],
    });

    expect(first.nextState.totalExecuted).toBe(1);
    expect(first.nextState.countedChildIDs['subtask:part_1']).toBe(true);

    const second = reconcileChildrenState(first.nextState, {
      data: [
        {
          id: 'ses_child',
          parentID: 'ses_parent',
          messageID: 'msg_1',
          title: 'Fallback work',
          source: 'session',
          status: 'running',
          startedAt: '2026-06-04T00:00:01.000Z',
          updatedAt: '2026-06-04T00:00:01.000Z',
        },
      ],
    });

    expect(second.nextState.totalExecuted).toBe(1);
    expect(second.nextState.countedChildIDs.ses_child).toBe(true);
    expect(second.nextState.countedChildIDs['subtask:part_1']).toBeUndefined();
  });

  it('prunes synthetic running rows once their session anchor is no longer active', () => {
    const initial = createEmptyState();
    initial.children.ses_parent = {
      id: 'ses_parent',
      title: 'Parent session',
      parentID: 'ses_root',
      source: 'session',
      status: 'running',
      startedAt: '2026-06-04T11:50:00.000Z',
      updatedAt: '2026-06-04T11:55:00.000Z',
    };
    initial.children['subtask:part_1'] = {
      id: 'subtask:part_1',
      title: 'Synthetic fallback',
      parentID: 'ses_parent',
      messageID: 'msg_1',
      source: 'subtask',
      status: 'running',
      startedAt: '2026-06-04T11:50:00.000Z',
      updatedAt: '2026-06-04T11:50:00.000Z',
    };
    initial.children.ses_child = {
      id: 'ses_child',
      title: 'Real child',
      parentID: 'ses_parent',
      source: 'session',
      targetSessionID: 'ses_child',
      status: 'running',
      startedAt: '2026-06-04T11:50:00.000Z',
      updatedAt: '2026-06-04T11:55:00.000Z',
    };
    initial.countedChildIDs = { ses_child: true };
    initial.totalExecuted = 1;

    const result = reconcileChildrenState(initial, {
      data: [
        {
          id: 'ses_parent',
          parentID: 'ses_parent',
          title: 'Parent session',
          status: 'done',
          startedAt: '2026-06-04T11:50:00.000Z',
          updatedAt: '2026-06-04T12:00:00.000Z',
        },
      ],
    });

    expect(result.changed).toBe(true);
    expect(result.nextState.children['subtask:part_1']).toBeUndefined();
    expect(result.nextState.children.ses_parent).toMatchObject({
      status: 'done',
      endedAt: '2026-06-04T12:00:00.000Z',
    });
  });

  it('keeps stale running real session rows when a later snapshot omits them', () => {
    const initial = createEmptyState();
    initial.children.ses_child = {
      id: 'ses_child',
      title: 'Real child',
      parentID: 'ses_parent',
      source: 'session',
      targetSessionID: 'ses_child',
      status: 'running',
      startedAt: '2026-06-04T11:50:00.000Z',
      updatedAt: '2026-06-04T11:55:00.000Z',
    };
    initial.children['tool:delegate_1'] = {
      id: 'tool:delegate_1',
      title: 'Synthetic tool row',
      parentID: 'ses_parent',
      source: 'tool',
      targetSessionID: 'ses_child',
      status: 'running',
      startedAt: '2026-06-04T11:50:00.000Z',
      updatedAt: '2026-06-04T11:55:00.000Z',
    };
    initial.countedChildIDs = { ses_child: true };
    initial.totalExecuted = 1;

    const result = reconcileChildrenState(initial, { data: [] });

    expect(result.changed).toBe(false);
    expect(result.nextState.children.ses_child).toMatchObject({ status: 'running' });
    expect(result.nextState.children.ses_child).not.toHaveProperty('endedAt');
    expect(result.nextState.children['tool:delegate_1']).toMatchObject({ status: 'running' });
    expect(result.nextState.children['tool:delegate_1']).not.toHaveProperty('endedAt');
    expect(result.nextState.countedChildIDs).toEqual({ ses_child: true });
    expect(result.nextState.totalExecuted).toBe(1);
  });

  it('drops synthetic tool wrappers when no real session anchor remains in the snapshot', () => {
    const initial = createEmptyState();
    initial.children['tool:delegate_1'] = {
      id: 'tool:delegate_1',
      title: 'Delegation wrapper',
      parentID: 'ses_parent',
      source: 'tool',
      targetSessionID: 'ses_child',
      status: 'running',
      startedAt: '2026-06-04T11:50:00.000Z',
      updatedAt: '2026-06-04T11:55:00.000Z',
    };

    const result = reconcileChildrenState(initial, { data: [] });

    expect(result.changed).toBe(true);
    expect(result.nextState.children['tool:delegate_1']).toBeUndefined();
  });

  it('keeps a terminal child closed when an older running snapshot reports it as running', () => {
    const initial = createEmptyState();
    initial.children.ses_child = {
      id: 'ses_child',
      title: 'Recovered child',
      parentID: 'ses_parent',
      source: 'session',
      status: 'done',
      startedAt: '2026-06-04T11:55:00.000Z',
      updatedAt: '2026-06-04T11:56:00.000Z',
      endedAt: '2026-06-04T11:56:00.000Z',
      elapsedMs: 60_000,
    };

    const result = reconcileChildrenState(initial, {
      data: [
        {
          id: 'ses_child',
          parentID: 'ses_parent',
          title: 'Recovered child',
          source: 'session',
          status: 'running',
          startedAt: '2026-06-04T11:55:00.000Z',
          updatedAt: '2026-06-04T11:55:30.000Z',
        },
      ],
    });

    expect(result.nextState.children.ses_child).toMatchObject({
      status: 'done',
      endedAt: '2026-06-04T11:56:00.000Z',
    });
  });

  it('reopens a done child when a newer live snapshot reports it as running', () => {
    const initial = createEmptyState();
    initial.children.ses_child = {
      id: 'ses_child',
      title: 'Recovered child',
      parentID: 'ses_parent',
      source: 'session',
      status: 'done',
      color: 'green',
      startedAt: '2026-06-04T11:55:00.000Z',
      updatedAt: '2026-06-04T11:56:00.000Z',
      endedAt: '2026-06-04T11:56:00.000Z',
      elapsedMs: 60_000,
    };

    const result = reconcileChildrenState(initial, {
      data: [
        {
          id: 'ses_child',
          parentID: 'ses_parent',
          title: 'Recovered child',
          source: 'session',
          status: 'running',
          startedAt: '2026-06-04T11:55:00.000Z',
          updatedAt: '2026-06-04T12:00:00.000Z',
        },
      ],
    });

    expect(result.nextState.children.ses_child).toMatchObject({
      status: 'running',
      color: 'yellow',
      updatedAt: '2026-06-04T12:00:00.000Z',
      endedAt: undefined,
    });
  });

  it('reopens an errored child when a newer live snapshot reports it as running', () => {
    const initial = createEmptyState();
    initial.children.ses_child = {
      id: 'ses_child',
      title: 'Recovered child',
      parentID: 'ses_parent',
      source: 'session',
      status: 'error',
      color: 'red',
      startedAt: '2026-06-04T11:55:00.000Z',
      updatedAt: '2026-06-04T11:56:00.000Z',
      endedAt: '2026-06-04T11:56:00.000Z',
    };

    const result = reconcileChildrenState(initial, {
      data: [
        {
          id: 'ses_child',
          parentID: 'ses_parent',
          title: 'Recovered child',
          source: 'session',
          status: 'running',
          startedAt: '2026-06-04T11:55:00.000Z',
          updatedAt: '2026-06-04T12:00:00.000Z',
        },
      ],
    });

    expect(result.nextState.children.ses_child).toMatchObject({
      status: 'running',
      color: 'yellow',
      updatedAt: '2026-06-04T12:00:00.000Z',
      endedAt: undefined,
    });
  });

  it('excludes delegation-style rows from execution totals', () => {
    const result = reconcileChildrenState(createEmptyState(), {
      data: [
        {
          id: 'ses_delegate',
          parentID: 'ses_parent',
          title: 'Delegation: faint-magenta-flea',
          source: 'session',
          status: 'running',
          startedAt: '2026-06-04T11:55:00.000Z',
          updatedAt: '2026-06-04T11:55:00.000Z',
        },
        {
          id: 'ses_task',
          parentID: 'ses_parent',
          title: 'Task row',
          source: 'session',
          status: 'running',
          startedAt: '2026-06-04T11:56:00.000Z',
          updatedAt: '2026-06-04T11:56:00.000Z',
        },
      ],
    });

    expect(result.nextState.totalExecuted).toBe(1);
    expect(result.nextState.countedChildIDs.ses_task).toBe(true);
    expect(result.nextState.countedChildIDs.ses_delegate).toBeUndefined();
  });
});
