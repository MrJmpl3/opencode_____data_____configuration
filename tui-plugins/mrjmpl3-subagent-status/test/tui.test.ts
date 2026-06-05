import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TuiPluginApi } from '@opencode-ai/plugin/tui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import plugin from '../index.tsx';
import { buildTuiSnapshot, elapsedMs } from '../runtime/snapshot.ts';
import { navigateToChildSession, resolveNavigationSessionID } from '../runtime/navigation.ts';
import { hydrateChildTokensFromLogs } from '../runtime/runtime.tsx';
import type { SubagentChild, SubagentState } from '../state/types.ts';
import { persistSnapshot } from '../storage/persistence.ts';

function createChild(
  overrides: Partial<SubagentChild> & Pick<SubagentChild, 'id' | 'title' | 'parentID'>,
): SubagentChild {
  return {
    id: overrides.id,
    title: overrides.title,
    parentID: overrides.parentID,
    status: overrides.status ?? 'running',
    startedAt: overrides.startedAt ?? '2026-06-04T11:50:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-06-04T11:55:00.000Z',
    endedAt: overrides.endedAt,
    source: overrides.source,
    targetSessionID: overrides.targetSessionID,
    messageID: overrides.messageID,
    agentName: overrides.agentName,
    summary: overrides.summary,
    color: overrides.color,
    elapsedMs: overrides.elapsedMs,
    tokens: overrides.tokens,
  };
}

function createState(children: SubagentChild[], totalExecuted = children.length): SubagentState {
  return {
    children: Object.fromEntries(children.map((child) => [child.id, child])),
    countedChildIDs: Object.fromEntries(children.map((child) => [child.id, true])),
    purgedSessionIDs: {},
    totalExecuted,
    updatedAt: '2026-06-04T12:00:00.000Z',
  };
}

describe('tui elapsed time', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('freezes terminal elapsed time at completion', () => {
    const child: SubagentChild = {
      id: 'ses_1',
      title: 'Runner',
      parentID: 'ses_parent',
      status: 'done',
      startedAt: '2026-06-04T11:50:00.000Z',
      updatedAt: '2026-06-04T11:55:00.000Z',
      endedAt: '2026-06-04T11:55:00.000Z',
    };

    expect(elapsedMs(child, Date.parse('2026-06-04T12:00:00.000Z'))).toBe(5 * 60 * 1000);
    expect(elapsedMs(child, Date.parse('2026-06-04T13:00:00.000Z'))).toBe(5 * 60 * 1000);
  });

  it('builds visible counts from clickable child rows and produces persisted status text', () => {
    const doneSession = createChild({
      id: 'ses_child_done',
      title: 'Implement sidebar sync',
      parentID: 'ses_parent',
      source: 'session',
      status: 'done',
      messageID: 'msg-active',
      endedAt: '2026-06-04T11:57:00.000Z',
      updatedAt: '2026-06-04T11:57:00.000Z',
      elapsedMs: 2 * 60 * 1000,
      tokens: { total: 420, contextPercent: 58 },
    });
    const runningSession = createChild({
      id: 'ses_child_running',
      title: 'Review tokens',
      parentID: 'ses_parent',
      source: 'session',
      status: 'running',
      messageID: 'msg-active',
      updatedAt: '2026-06-04T11:59:30.000Z',
      elapsedMs: 30 * 1000,
    });
    const erroredSession = createChild({
      id: 'ses_child_error',
      title: 'Handle failure',
      parentID: 'ses_parent',
      source: 'session',
      status: 'error',
      endedAt: '2026-06-04T11:58:00.000Z',
      updatedAt: '2026-06-04T11:58:00.000Z',
      elapsedMs: 60 * 1000,
    });

    const snapshot = buildTuiSnapshot(
      createState([doneSession, runningSession, erroredSession], 3),
      Date.parse('2026-06-04T12:00:00.000Z'),
    );

    expect(snapshot.counts).toEqual({ running: 1, done: 1, error: 1 });
    expect(snapshot.visibleChildren.map((child) => child.id)).toHaveLength(3);
    expect(snapshot.visibleChildren.map((child) => child.id)).toEqual(
      expect.arrayContaining(['ses_child_running', 'ses_child_error', 'ses_child_done']),
    );
    expect(snapshot.statusLine).toContain('Subagents: 1 run · 1 done · 1 err · Σ 3');
    expect(snapshot.statusLine).toContain('Implement sidebar sync');
    expect(snapshot.statusLine).toContain('420 ctx 58%');
  });

  it('keeps completed rows visible without token metadata when the current snapshot has no token data', () => {
    const doneSession = createChild({
      id: 'ses_child_done_no_tokens',
      title: 'Done without tokens',
      parentID: 'ses_parent',
      source: 'session',
      status: 'done',
      endedAt: '2026-06-04T11:57:30.000Z',
      updatedAt: '2026-06-04T11:57:30.000Z',
      elapsedMs: 90 * 1000,
    });

    const snapshot = buildTuiSnapshot(createState([doneSession], 1), Date.parse('2026-06-04T12:00:00.000Z'));

    expect(snapshot.counts).toEqual({ running: 0, done: 1, error: 0 });
    expect(snapshot.visibleChildren.map((child) => child.id)).toEqual(['ses_child_done_no_tokens']);
    expect(snapshot.statusLine).toContain('Done without tokens');
    expect(snapshot.statusLine).not.toContain('ctx');
  });

  it('hydrates tokens onto a synthetic done row from matching log data', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mrjmpl3-subagent-status-data-'));
    tempDirs.push(dataDir);
    const logDir = join(dataDir, 'opencode', 'log');
    const logPath = join(logDir, '2026-06-04.log');

    vi.stubEnv('XDG_DATA_HOME', dataDir);
    await mkdir(logDir, { recursive: true });
    await writeFile(
      logPath,
      '2026-06-04T00:00:00.000Z session=ses_tool_row {"tokens":{"input":12,"output":8,"total":20,"contextPercent":42.5}}',
      'utf8',
    );

    const row = createChild({
      id: 'tool:row',
      title: 'Synthetic tool row',
      parentID: 'ses_parent',
      source: 'tool',
      status: 'done',
      targetSessionID: 'ses_tool_row',
      endedAt: '2026-06-04T11:57:00.000Z',
      updatedAt: '2026-06-04T11:57:00.000Z',
      elapsedMs: 2 * 60 * 1000,
    });
    const state = createState([row], 1);

    expect(hydrateChildTokensFromLogs(state)).toBe(true);
    expect(state.children[row.id]?.tokens).toEqual({
      input: 12,
      output: 8,
      total: 20,
      contextPercent: 42.5,
    });
  });

  it('persists the rendered status line for the current visible snapshot', async () => {
    vi.setSystemTime(new Date('2026-06-04T12:00:00.000Z'));
    const statePath = join(await mkdtemp(join(tmpdir(), 'mrjmpl3-subagent-status-')), 'state.json');
    const textPath = join(statePath, '..', 'status.txt');
    const debugPath = join(statePath, '..', 'debug.json');
    const state = createState(
      [
        createChild({
          id: 'ses_child_done',
          title: 'Persist me',
          parentID: 'ses_parent',
          source: 'session',
          status: 'done',
          endedAt: '2026-06-04T11:57:00.000Z',
          updatedAt: '2026-06-04T11:57:00.000Z',
          elapsedMs: 2 * 60 * 1000,
          tokens: { total: 64 },
        }),
      ],
      1,
    );

    await persistSnapshot(statePath, textPath, state);

    const snapshot = buildTuiSnapshot(state);
    expect(readFileSync(textPath, 'utf8')).toBe(snapshot.statusSnapshotLine);
    expect(JSON.parse(readFileSync(debugPath, 'utf8'))).toMatchObject({
      source: 'load',
      snapshotSemantics: 'snapshot',
      trackedCounts: { running: 0, done: 1, error: 0 },
      visibleCounts: { running: 0, done: 1, error: 0 },
    });
  });

  it('reports tracked totals even when some terminal rows are hidden from view', () => {
    const recentDone = createChild({
      id: 'ses_recent',
      title: 'Recent done child',
      parentID: 'ses_parent',
      source: 'session',
      status: 'done',
      endedAt: '2026-06-04T11:57:00.000Z',
      updatedAt: '2026-06-04T11:57:00.000Z',
    });
    const staleDone = createChild({
      id: 'ses_stale',
      title: 'Stale done child',
      parentID: 'ses_parent',
      source: 'session',
      status: 'done',
      endedAt: '2026-06-04T11:00:00.000Z',
      updatedAt: '2026-06-04T11:00:00.000Z',
    });

    const snapshot = buildTuiSnapshot(createState([recentDone, staleDone], 2), Date.parse('2026-06-04T12:00:00.000Z'));

    expect(snapshot.counts).toEqual({ running: 0, done: 2, error: 0 });
    expect(snapshot.visibleCounts).toEqual({ running: 0, done: 1, error: 0 });
    expect(snapshot.visibleChildren.map((child) => child.id)).toEqual(['ses_recent']);
    expect(snapshot.statusLine).toContain('2 done');
  });

  it('captures persistence diagnostics for refresh reconciliation', async () => {
    vi.setSystemTime(new Date('2026-06-04T12:00:00.000Z'));
    const statePath = join(await mkdtemp(join(tmpdir(), 'mrjmpl3-subagent-status-')), 'state.json');
    const textPath = join(statePath, '..', 'status.txt');
    const debugPath = join(statePath, '..', 'debug.json');
    const state = createState([
      createChild({
        id: 'ses_child_running',
        title: 'Running child',
        parentID: 'ses_parent',
        source: 'session',
        status: 'running',
      }),
    ]);

    await persistSnapshot(statePath, textPath, state, {
      source: 'refresh',
      lastEventType: 'session.updated',
      bufferedEventCount: 3,
    });

    expect(JSON.parse(readFileSync(debugPath, 'utf8'))).toMatchObject({
      source: 'refresh',
      lastEventType: 'session.updated',
      bufferedEventCount: 3,
      snapshotSemantics: 'snapshot',
    });
  });

  it('navigates only to clickable child sessions and keeps keyboard behavior unavailable', async () => {
    const navigate = vi.fn();
    const eventNames: string[] = [];
    const disposers: Array<() => void> = [];
    const slotRegistrations: Array<{ slots: Record<string, (...args: unknown[]) => unknown> }> = [];

    const api = {
      client: {
        session: {
          children: vi.fn(async () => ({ data: [] })),
          status: vi.fn(async () => ({ data: {} })),
          messages: vi.fn(async () => ({ data: [] })),
        },
      },
      event: {
        on: (eventName: string, handler: (event: unknown) => void) => {
          eventNames.push(eventName);
          return () => handler;
        },
      },
      lifecycle: {
        onDispose: (handler: () => void) => {
          disposers.push(handler);
        },
      },
      route: { navigate },
      slots: {
        register: (registration: { slots: Record<string, (...args: unknown[]) => unknown> }) => {
          slotRegistrations.push(registration);
        },
      },
      state: {
        path: { directory: '/tmp' },
        session: {
          children: vi.fn(async () => ({ data: [] })),
          messages: vi.fn(() => []),
          status: vi.fn(() => undefined),
        },
      },
      theme: {
        current: { text: 'white', textMuted: 'gray', warning: 'yellow', success: 'green', error: 'red' },
      },
    } as unknown as TuiPluginApi;

    expect(
      navigateToChildSession(api, createChild({ id: 'ses_clickable', title: 'Clickable', parentID: 'ses_parent' })),
    ).toBe(true);
    expect(navigate).toHaveBeenCalledWith('session', { sessionID: 'ses_clickable' });
    expect(
      navigateToChildSession(
        api,
        createChild({ id: 'tool:1', title: 'Not clickable', parentID: 'ses_parent', targetSessionID: 'task_1' }),
      ),
    ).toBe(false);
    expect(navigate).toHaveBeenCalledTimes(1);

    expect(
      resolveNavigationSessionID(
        createChild({
          id: 'tool:2',
          title: 'Synthetic done row',
          parentID: 'ses_parent',
          targetSessionID: 'ses_child',
        }),
      ),
    ).toBe('ses_child');

    await plugin.tui(api, undefined, undefined as never);

    expect(slotRegistrations).toHaveLength(1);
    expect(slotRegistrations[0]?.slots.home_bottom).toBeTypeOf('function');
    expect(eventNames).not.toEqual(expect.arrayContaining(['keypress', 'keydown', 'keyup', 'focus', 'blur']));
    expect(eventNames.every((eventName) => !/(key|keyboard|focus|command)/i.test(eventName))).toBe(true);

    disposers.forEach((dispose) => dispose());
  });

  it('binds row navigation to mouse release instead of mouse press', () => {
    const source = readFileSync(new URL('../runtime/view.tsx', import.meta.url), 'utf8');

    expect(source).toMatch(/onMouseUp=\{[\s\S]*navigateToChildSession\(props\.api, props\.child\)/);
    expect(source).not.toMatch(/onMouseDown=\{[\s\S]*navigateToChildSession\(props\.api, props\.child\)/);
  });
});
