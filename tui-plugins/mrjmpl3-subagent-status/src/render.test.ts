import { describe, expect, it } from 'vitest';

import {
  collapseSubagentWorkItems,
  formatContextCompact,
  renderStatusLine,
  statusColor,
  visibleSubagentWorkItems,
} from './render.ts';
import type { SubagentChild, SubagentState } from './types.ts';

function child(overrides: Partial<SubagentChild> = {}): SubagentChild {
  return {
    id: 'ses_child',
    title: 'Review auth changes',
    parentID: 'ses_parent',
    messageID: 'msg_1',
    source: 'session',
    targetSessionID: 'ses_child',
    status: 'running',
    color: 'yellow',
    startedAt: '2026-06-04T10:00:00.000Z',
    updatedAt: '2026-06-04T10:01:00.000Z',
    elapsedMs: 61_000,
    ...overrides,
  };
}

describe('render', () => {
  it('collapses matching synthetic and session rows into one visible execution', () => {
    const synthetic = child({
      id: 'tool:part_1',
      title: 'Investigate flaky tests',
      source: 'tool',
      targetSessionID: 'ses_child',
      agentName: 'tester',
    });
    const session = child({
      id: 'ses_child',
      title: 'Investigate flaky tests',
      source: 'session',
      status: 'done',
      color: 'green',
      endedAt: '2026-06-04T10:04:00.000Z',
      elapsedMs: 240_000,
    });

    expect(collapseSubagentWorkItems([synthetic, session])).toEqual([
      expect.objectContaining({
        id: 'tool:part_1',
        status: 'done',
        color: 'green',
        targetSessionID: 'ses_child',
        elapsedMs: 240_000,
      }),
    ]);
  });

  it('keeps recent terminal rows visible while hiding stale done rows', () => {
    const nowMs = Date.parse('2026-06-04T10:20:00.000Z');
    const visibleDone = child({
      id: 'done_recent',
      status: 'done',
      color: 'green',
      endedAt: '2026-06-04T10:15:00.000Z',
    });
    const hiddenDone = child({
      id: 'done_old',
      status: 'done',
      color: 'green',
      endedAt: '2026-06-04T10:00:00.000Z',
    });

    expect(visibleSubagentWorkItems([visibleDone, hiddenDone], nowMs).map((item) => item.id)).toEqual(['done_recent']);
  });

  it('formats compact token/context text and aggregate statusline output', () => {
    const recentEndedAt = new Date(Date.now() - 60_000).toISOString();

    const doneChild = child({
      id: 'ses_done',
      title: 'Summarize results',
      status: 'done',
      color: 'green',
      messageID: 'msg_active',
      endedAt: recentEndedAt,
      updatedAt: recentEndedAt,
      elapsedMs: 120_000,
      tokens: { input: 1200, output: 300, contextPercent: 42.3 },
    });
    const runningChild = child({
      id: 'ses_running',
      title: 'Run tests',
      messageID: 'msg_active',
      status: 'running',
      color: 'yellow',
    });
    const state: SubagentState = {
      children: {
        ses_done: doneChild,
        ses_running: runningChild,
      },
      countedChildIDs: { ses_done: true, ses_running: true },
      totalExecuted: 2,
      updatedAt: '2026-06-04T10:02:00.000Z',
    };

    expect(formatContextCompact(doneChild)).toBe('1.5k ctx 42%');
    expect(renderStatusLine(state)).toContain('Subagents: 1 run · 1 done · 0 err · Σ 2');
    expect(renderStatusLine(state)).toContain('Summarize results 02:00 1.5k ctx 42%');
  });

  it('maps statuses to the expected color keys', () => {
    expect(statusColor('running')).toBe('yellow');
    expect(statusColor('done')).toBe('green');
    expect(statusColor('error')).toBe('red');
  });
});
