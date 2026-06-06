import { describe, expect, it } from 'vitest';

import {
  buildSubagentSnapshotView,
  collapseSubagentWorkItems,
  renderStatusLine,
  splitSidebarVisibleSections,
  visibleSubagentWorkItems,
} from '../src/ui/view-model.ts';
import {
  formatContextCompact,
  formatCount,
  formatRelativeRecency,
  formatSidebarRunningMeta,
  formatSidebarTerminalMeta,
  formatSidebarTitle,
  formatTokenCompact,
  formatUsageCompact,
  statusColor,
  truncateLabel,
} from '../src/ui/format.ts';
import type { SubagentChild, SubagentState } from '../src/domain/types.ts';

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

  it('does not hide a real running session when a stale synthetic wrapper fails to match it', () => {
    const staleSynthetic = child({
      id: 'tool:stale_delegate',
      title: 'delegate',
      parentID: 'ses_other_parent',
      messageID: 'msg_stale',
      source: 'tool',
      targetSessionID: 'ses_child',
      status: 'done',
      color: 'green',
      endedAt: '2026-06-04T10:00:30.000Z',
      updatedAt: '2026-06-04T10:00:30.000Z',
    });
    const runningSession = child({
      id: 'ses_child',
      title: 'Investigate flaky tests',
      parentID: 'ses_parent',
      messageID: 'msg_1',
      source: 'session',
      status: 'running',
      color: 'yellow',
      targetSessionID: 'ses_child',
    });

    expect(collapseSubagentWorkItems([staleSynthetic, runningSession]).map((item) => item.id)).toEqual([
      'tool:stale_delegate',
      'ses_child',
    ]);
  });

  it('keeps unmatched real sessions visible when one synthetic row ambiguously matches multiple sessions', () => {
    const synthetic = child({
      id: 'tool:delegate_1',
      title: 'delegate',
      source: 'tool',
      messageID: 'msg_1',
      parentID: 'ses_parent',
      targetSessionID: undefined,
    });
    const primarySession = child({
      id: 'ses_primary',
      title: 'Investigate flaky tests',
      source: 'session',
      messageID: 'msg_1',
      parentID: 'ses_parent',
      startedAt: '2026-06-04T10:02:00.000Z',
      updatedAt: '2026-06-04T10:02:00.000Z',
    });
    const secondarySession = child({
      id: 'ses_secondary',
      title: 'Investigate flaky tests',
      source: 'session',
      messageID: 'msg_1',
      parentID: 'ses_parent',
      startedAt: '2026-06-04T10:01:00.000Z',
      updatedAt: '2026-06-04T10:01:00.000Z',
    });

    expect(collapseSubagentWorkItems([synthetic, primarySession, secondarySession]).map((item) => item.id)).toEqual([
      'tool:delegate_1',
      'ses_secondary',
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
    const nowMs = Date.parse('2026-06-04T12:00:00.000Z');
    const recentEndedAt = new Date(nowMs - 60_000).toISOString();

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
      purgedSessionIDs: {},
      totalExecuted: 2,
      updatedAt: '2026-06-04T10:02:00.000Z',
    };

    expect(formatTokenCompact(doneChild)).toBe('1.5k tok');
    expect(formatContextCompact(doneChild)).toBe('42%');
    expect(formatUsageCompact(doneChild)).toBe('1.5k tok 42%');
    expect(renderStatusLine(state, nowMs)).toContain('Subagents: 1 run · 1 done · 0 err · Σ 2');
    expect(renderStatusLine(state, nowMs)).toContain('Summarize results 1:59:00 1.5k tok 42%');
  });

  it('keeps token and context formatting semantically separate', () => {
    const tokenOnlyChild = child({ tokens: { input: 1200, output: 300 } });
    const contextOnlyChild = child({ tokens: { contextPercent: 42.3 } });

    expect(formatTokenCompact(tokenOnlyChild)).toBe('1.5k tok');
    expect(formatContextCompact(tokenOnlyChild)).toBe('');
    expect(formatUsageCompact(tokenOnlyChild)).toBe('1.5k tok');

    expect(formatTokenCompact(contextOnlyChild)).toBe('');
    expect(formatContextCompact(contextOnlyChild)).toBe('42%');
    expect(formatUsageCompact(contextOnlyChild)).toBe('42%');
  });

  it('truncates sidebar titles and keeps agent names out of the primary row label', () => {
    const sidebarChild = child({
      title: 'Implement a much wider render treatment for the subagent sidebar than the layout can fit',
      summary: 'Prioritize task name visibility even when metadata is long',
      agentName: 'render-specialist',
    });

    expect(truncateLabel('   lots   of    gaps   ', 12)).toBe('lots of gaps');
    expect(formatSidebarTitle(sidebarChild)).toBe('Prioritize task name visibi…');
    expect(formatSidebarTitle(sidebarChild)).not.toContain('render-specialist');
  });

  it('handles truncation boundaries for tiny widths and whitespace-only labels', () => {
    expect(truncateLabel('x', 1)).toBe('x');
    expect(truncateLabel('xy', 1)).toBe('…');
    expect(truncateLabel('      ', 5)).toBe('');
    expect(truncateLabel('exact width', 'exact width'.length)).toBe('exact width');
  });

  it('formats running and terminal sidebar metadata in compact fixed-width friendly chunks', () => {
    const nowMs = Date.parse('2026-06-04T10:06:00.000Z');
    const runningChild = child({
      title: 'Review width handling',
      agentName: 'render-specialist',
      elapsedMs: 61_000,
      tokens: { total: 1530, contextPercent: 42.3 },
    });
    const doneChild = child({
      status: 'done',
      endedAt: '2026-06-04T10:04:00.000Z',
      updatedAt: '2026-06-04T10:04:00.000Z',
      elapsedMs: 4 * 60 * 1000,
      tokens: { total: 1530, contextPercent: 42.3 },
    });

    expect(formatSidebarRunningMeta(runningChild)).toEqual({
      primary: '01:01 · @render-spec…',
      secondary: '1.5k 42%',
    });
    expect(formatRelativeRecency(doneChild.endedAt, nowMs)).toBe('2m ago');
    expect(formatSidebarTerminalMeta(doneChild, nowMs)).toBe('2m ago · 1.5k 42%');
    expect(formatCount(1200)).toBe('1,200');
  });

  it('splits visible sidebar rows into active and recent sections without reordering within each group', () => {
    const runningChild = child({ id: 'ses_running' });
    const errorChild = child({ id: 'ses_error', status: 'error', color: 'red' });
    const doneChild = child({ id: 'ses_done', status: 'done', color: 'green' });

    const sections = splitSidebarVisibleSections([runningChild, errorChild, doneChild]);

    expect(sections.active.map((item) => item.id)).toEqual(['ses_running']);
    expect(sections.recent.map((item) => item.id)).toEqual(['ses_error', 'ses_done']);
  });

  it('keeps tracked totals honest when visible rows are pruned', () => {
    const nowMs = Date.parse('2026-06-04T10:20:00.000Z');
    const recentDone = child({
      id: 'done_recent',
      status: 'done',
      color: 'green',
      endedAt: '2026-06-04T10:15:00.000Z',
    });
    const staleDone = child({
      id: 'done_old',
      status: 'done',
      color: 'green',
      endedAt: '2026-06-04T09:30:00.000Z',
    });

    const view = buildSubagentSnapshotView([recentDone, staleDone], nowMs);

    expect(view.trackedCounts).toEqual({ running: 0, done: 2, error: 0 });
    expect(view.visibleCounts).toEqual({ running: 0, done: 1, error: 0 });
    expect(view.visibleChildren.map((item) => item.id)).toEqual(['done_recent']);
    expect(
      renderStatusLine(
        {
          children: { done_recent: recentDone, done_old: staleDone },
          countedChildIDs: {},
          purgedSessionIDs: {},
          totalExecuted: 2,
          updatedAt: '2026-06-04T10:20:00.000Z',
        },
        nowMs,
      ),
    ).toContain('2 done');
  });

  it('maps statuses to the expected color keys', () => {
    expect(statusColor('running')).toBe('yellow');
    expect(statusColor('done')).toBe('green');
    expect(statusColor('error')).toBe('red');
  });
});
