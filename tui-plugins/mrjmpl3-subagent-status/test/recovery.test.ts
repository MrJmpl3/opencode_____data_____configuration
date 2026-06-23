import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { readFile } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setDebugEnabled } from '../src/shared/debug.ts';
import {
  createSQLiteRecoverySource,
  resolveRecoveredStatus,
  safeParseParts,
} from '../src/infrastructure/recovery/sqlite.ts';
import { createEmptyState, getCounts } from '../src/domain/state.ts';
import { applyRecoveredChildren } from '../src/infrastructure/recovery.ts';
import { splitSidebarVisibleSections } from '../src/ui/view-model/visibility.ts';

const createSQLiteRecoveryDatabase = async (path: string, script: string): Promise<void> => {
  execFileSync('python3', ['-c', script, path], { encoding: 'utf8' });
};

describe('sqlite recovery source', () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-04T05:25:00.000Z'));
  });

  afterEach(async () => {
    setDebugEnabled(false);
    vi.restoreAllMocks();
    vi.useRealTimers();

    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('marks step-finish-only SQLite evidence done when no newer running evidence exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mrjmpl3-subagent-status-'));
    tempDirs.push(dir);
    const databasePath = join(dir, 'opencode.db');

    await createSQLiteRecoveryDatabase(
      databasePath,
      [
        'import json, sqlite3, sys',
        'path = sys.argv[1]',
        'conn = sqlite3.connect(path)',
        'cur = conn.cursor()',
        "cur.execute('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER)')",
        "cur.execute('CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)')",
        "cur.execute('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ('ses_1468147afffePt1H1Qt7VKwLho', 'ses_parent', 'Show Cascadia defaults', 'general', 1780550100000, 1780550405000, 12, 8, 0, 0, 0))",
        'parts = [',
        "  ('prt_step_start', 1780550280000, 1780550280000, {'id': 'prt_step_start', 'sessionID': 'ses_1468147afffePt1H1Qt7VKwLho', 'messageID': 'msg_cascadia', 'type': 'step-start', 'time': {'start': 1780550280000}}),",
        "  ('prt_progress_text', 1780550340000, 1780550340000, {'id': 'prt_progress_text', 'sessionID': 'ses_1468147afffePt1H1Qt7VKwLho', 'messageID': 'msg_cascadia', 'type': 'text', 'text': 'Cascadia Code ships with several stylistic set defaults.', 'time': {'created': 1780550340000, 'updated': 1780550340000}}),",
        "  ('prt_step_finish', 1780550400000, 1780550400000, {'id': 'prt_step_finish', 'sessionID': 'ses_1468147afffePt1H1Qt7VKwLho', 'messageID': 'msg_cascadia', 'type': 'step-finish', 'reason': 'stop', 'tokens': {'input': 12, 'output': 8, 'total': 20}, 'time': {'end': 1780550400000}}),",
        "  ('prt_final_text', 1780550405000, 1780550405000, {'id': 'prt_final_text', 'sessionID': 'ses_1468147afffePt1H1Qt7VKwLho', 'messageID': 'msg_cascadia', 'type': 'text', 'text': 'Final answer: Cascadia defaults are available.', 'time': {'created': 1780550405000, 'updated': 1780550405000}}),",
        ']',
        'for part_id, created_at, updated_at, data in parts:',
        "    cur.execute('INSERT INTO part VALUES (?, ?, ?, ?, ?)', (part_id, 'ses_1468147afffePt1H1Qt7VKwLho', created_at, updated_at, json.dumps(data)))",
        'conn.commit()',
      ].join('\n'),
    );

    const state = createEmptyState();
    state.children.ses_1468147afffePt1H1Qt7VKwLho = {
      id: 'ses_1468147afffePt1H1Qt7VKwLho',
      title: 'Show Cascadia defaults',
      parentID: 'ses_parent',
      source: 'session',
      status: 'running',
      startedAt: '2026-06-04T05:15:00.000Z',
      updatedAt: '2026-06-04T05:19:00.000Z',
    };
    state.children['tool:ses_1468147afffePt1H1Qt7VKwLho'] = {
      id: 'tool:ses_1468147afffePt1H1Qt7VKwLho',
      title: 'Show Cascadia defaults',
      parentID: 'ses_parent',
      source: 'tool',
      targetSessionID: 'ses_1468147afffePt1H1Qt7VKwLho',
      status: 'running',
      startedAt: '2026-06-04T05:15:00.000Z',
      updatedAt: '2026-06-04T05:19:00.000Z',
    };

    const source = createSQLiteRecoverySource({ databasePath });
    await source.hydrateState(state, {
      directory: '/tmp/workspace',
      parentSessionID: 'ses_parent',
    });

    expect(state.children.ses_1468147afffePt1H1Qt7VKwLho).toMatchObject({
      status: 'done',
      tokens: { input: 12, output: 8, total: 20 },
    });
    expect(state.children.ses_1468147afffePt1H1Qt7VKwLho?.endedAt).toBe('2026-06-04T05:20:00.000Z');
    expect(state.children['tool:ses_1468147afffePt1H1Qt7VKwLho']).toMatchObject({
      status: 'done',
    });
    expect(state.children['tool:ses_1468147afffePt1H1Qt7VKwLho']?.endedAt).toBe('2026-06-04T05:20:00.000Z');
    expect(getCounts(state)).toMatchObject({ done: 2, running: 0 });
  });

  it('does not override newer persisted running rows when SQLite only has step-finish evidence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mrjmpl3-subagent-status-'));
    tempDirs.push(dir);
    const databasePath = join(dir, 'opencode.db');

    await createSQLiteRecoveryDatabase(
      databasePath,
      [
        'import json, sqlite3, sys',
        'path = sys.argv[1]',
        'conn = sqlite3.connect(path)',
        'cur = conn.cursor()',
        "cur.execute('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER)')",
        "cur.execute('CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)')",
        "cur.execute('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ('ses_14584472affeE6HD4fNRxdM0oq', 'ses_parent', 'Terminal child', 'sdd-apply', 1780550100000, 1780550400000, 12, 8, 0, 0, 0))",
        'payload = json.dumps({"type": "step-finish", "reason": "stop", "tokens": {"input": 12, "output": 8, "total": 20}, "time": {"end": 1780550400000}})',
        "cur.execute('INSERT INTO part VALUES (?, ?, ?, ?, ?)', ('prt_1', 'ses_14584472affeE6HD4fNRxdM0oq', 1780550399000, 1780550400000, payload))",
        'conn.commit()',
      ].join('\n'),
    );

    const state = createEmptyState();
    state.children.ses_14584472affeE6HD4fNRxdM0oq = {
      id: 'ses_14584472affeE6HD4fNRxdM0oq',
      title: 'Terminal child',
      parentID: 'ses_parent',
      source: 'session',
      targetSessionID: 'ses_14584472affeE6HD4fNRxdM0oq',
      status: 'running',
      startedAt: '2026-06-04T05:15:00.000Z',
      updatedAt: '2026-06-04T05:24:30.000Z',
    };

    const source = createSQLiteRecoverySource({ databasePath });
    await source.hydrateState(state, {
      directory: '/tmp/workspace',
      parentSessionID: 'ses_parent',
    });

    expect(state.children.ses_14584472affeE6HD4fNRxdM0oq).toMatchObject({
      status: 'done',
      updatedAt: '2026-06-04T05:20:00.000Z',
      endedAt: '2026-06-04T05:20:00.000Z',
      tokens: { input: 12, output: 8, total: 20 },
    });
  });

  it('preserves same-terminal recovered child timing while merging recovered metadata', () => {
    const state = createEmptyState();
    state.children.ses_failed = {
      id: 'ses_failed',
      title: 'Failed child',
      parentID: 'ses_parent',
      source: 'session',
      targetSessionID: 'ses_failed',
      status: 'error',
      color: 'red',
      startedAt: '2026-06-04T05:15:00.000Z',
      updatedAt: '2026-06-04T05:20:00.000Z',
      endedAt: '2026-06-04T05:20:00.000Z',
    };

    const result = applyRecoveredChildren(
      state,
      [
        {
          id: 'ses_failed',
          title: 'Failed child',
          parentID: 'ses_parent',
          source: 'session',
          targetSessionID: 'ses_failed',
          status: 'error',
          agentName: 'sdd-apply',
          startedAt: '2026-06-04T05:15:00.000Z',
          updatedAt: '2026-06-04T05:30:00.000Z',
          endedAt: '2026-06-04T05:30:00.000Z',
          tokens: { input: 12, output: 8, total: 20 },
        },
      ],
      ['ses_failed'],
      'ses_parent',
    );

    expect(result.changed).toBe(true);
    expect(state.children.ses_failed).toMatchObject({
      status: 'error',
      agentName: 'sdd-apply',
      tokens: { input: 12, output: 8, total: 20 },
      updatedAt: '2026-06-04T05:20:00.000Z',
      endedAt: '2026-06-04T05:20:00.000Z',
    });
  });

  it('uses large step-finish-only recovery as done evidence while preserving token evidence', async () => {
    const largePayload = 'x'.repeat(256 * 1024);
    const largeParts = [
      ...Array.from({ length: 104 }, (_, index) =>
        JSON.stringify({
          id: `prt_large_noise_${index}`,
          type: index % 2 === 0 ? 'text' : 'reasoning',
          text: largePayload,
          encrypted: largePayload,
        }),
      ),
      JSON.stringify({
        id: 'prt_step_finish',
        type: 'step-finish',
        reason: 'stop',
        tokens: { input: 12, output: 8, total: 20 },
        time: { end: 1780550400000 },
      }),
    ];

    const parsedParts = safeParseParts(largeParts);
    expect(parsedParts).toHaveLength(105);
    expect(resolveRecoveredStatus(parsedParts)).toMatchObject({
      status: 'done',
      endedAt: '2026-06-04T05:20:00.000Z',
      tokens: { input: 12, output: 8, total: 20 },
    });

    const dir = await mkdtemp(join(tmpdir(), 'mrjmpl3-subagent-status-'));
    tempDirs.push(dir);
    const databasePath = join(dir, 'opencode.db');

    await createSQLiteRecoveryDatabase(
      databasePath,
      [
        'import json, sqlite3, sys',
        'path = sys.argv[1]',
        'conn = sqlite3.connect(path)',
        'cur = conn.cursor()',
        "cur.execute('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER)')",
        "cur.execute('CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)')",
        "cur.execute('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ('ses_large_terminal', 'ses_parent', 'Large terminal child', 'sdd-apply', 1780550100000, 1780550400000, 12, 8, 0, 0, 0))",
        "large_text = 'x' * (128 * 1024)",
        'for index in range(104):',
        "    part_type = 'text' if index % 2 == 0 else 'reasoning'",
        "    payload = json.dumps({'id': 'prt_large_noise_' + str(index), 'type': part_type, 'text': large_text, 'encrypted': large_text})",
        "    cur.execute('INSERT INTO part VALUES (?, ?, ?, ?, ?)', ('prt_large_noise_' + str(index), 'ses_large_terminal', 1780550200000 + index, 1780550200000 + index, payload))",
        "terminal_payload = json.dumps({'id': 'prt_terminal', 'type': 'step-finish', 'reason': 'stop', 'tokens': {'input': 12, 'output': 8, 'total': 20}, 'time': {'end': 1780550400000}})",
        "cur.execute('INSERT INTO part VALUES (?, ?, ?, ?, ?)', ('prt_terminal', 'ses_large_terminal', 1780550399000, 1780550400000, terminal_payload))",
        'conn.commit()',
      ].join('\n'),
    );

    const state = createEmptyState();
    state.children.ses_large_terminal = {
      id: 'ses_large_terminal',
      title: 'Large terminal child',
      parentID: 'ses_parent',
      source: 'session',
      targetSessionID: 'ses_large_terminal',
      status: 'running',
      startedAt: '2026-06-04T05:15:00.000Z',
      updatedAt: '2026-06-04T05:20:00.101Z',
    };

    const source = createSQLiteRecoverySource({ databasePath });
    await source.hydrateState(state, {
      directory: '/tmp/workspace',
      parentSessionID: 'ses_parent',
    });

    expect(state.children.ses_large_terminal).toMatchObject({
      status: 'done',
      updatedAt: '2026-06-04T05:20:00.000Z',
      endedAt: '2026-06-04T05:20:00.000Z',
      tokens: { input: 12, output: 8, total: 20 },
    });
  });

  it('marks stale step-finish stop recovery as done instead of abandoned error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mrjmpl3-subagent-status-'));
    tempDirs.push(dir);
    const databasePath = join(dir, 'opencode.db');

    await createSQLiteRecoveryDatabase(
      databasePath,
      [
        'import json, sqlite3, sys',
        'path = sys.argv[1]',
        'conn = sqlite3.connect(path)',
        'cur = conn.cursor()',
        "cur.execute('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER)')",
        "cur.execute('CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)')",
        "cur.execute('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ('ses_step_finish_done', 'ses_parent', 'Finished child', 'sdd-apply', 1780530000000, 1780532400000, 12, 8, 0, 0, 0))",
        'payload = json.dumps({"type": "step-finish", "reason": "stop", "tokens": {"input": 12, "output": 8, "total": 20}, "time": {"end": 1780532400000}})',
        "cur.execute('INSERT INTO part VALUES (?, ?, ?, ?, ?)', ('prt_1', 'ses_step_finish_done', 1780532399000, 1780532400000, payload))",
        'conn.commit()',
      ].join('\n'),
    );

    const state = createEmptyState();
    const source = createSQLiteRecoverySource({ databasePath });

    await source.hydrateState(state, {
      directory: '/tmp/workspace',
      parentSessionID: 'ses_parent',
    });

    expect(state.children.ses_step_finish_done).toMatchObject({
      status: 'done',
      updatedAt: '2026-06-04T00:20:00.000Z',
      endedAt: '2026-06-04T00:20:00.000Z',
      tokens: { input: 12, output: 8, total: 20 },
    });
  });

  it('uses SQLite row timestamps for real-shaped step-finish payloads without payload time', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mrjmpl3-subagent-status-'));
    tempDirs.push(dir);
    const databasePath = join(dir, 'opencode.db');

    await createSQLiteRecoveryDatabase(
      databasePath,
      [
        'import json, sqlite3, sys',
        'path = sys.argv[1]',
        'conn = sqlite3.connect(path)',
        'cur = conn.cursor()',
        "cur.execute('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER)')",
        "cur.execute('CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)')",
        'sessions = [',
        "  ('ses_fresh_stop', 'Fresh real-shaped done', 1780550100000, 1780550400000, 12, 8),",
        "  ('ses_stale_stop', 'Stale real-shaped done', 1780530000000, 1780532400000, 12, 8),",
        "  ('ses_resumed_after_stop', 'Resumed after stop', 1780550100000, 1780550460000, 0, 0),",
        ']',
        'for session_id, title, created_at, updated_at, tokens_input, tokens_output in sessions:',
        "    cur.execute('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', (session_id, 'ses_parent', title, 'sdd-apply', created_at, updated_at, tokens_input, tokens_output, 0, 0, 0))",
        'parts = [',
        "  ('ses_fresh_stop', 'prt_fresh_start', 1780550340000, 1780550340000, {'type': 'step-start'}),",
        "  ('ses_fresh_stop', 'prt_fresh_tool_done', 1780550360000, 1780550360000, {'type': 'tool', 'state': {'status': 'completed'}}),",
        "  ('ses_fresh_stop', 'prt_fresh_stop', 1780550399000, 1780550400000, {'type': 'step-finish', 'reason': 'stop', 'tokens': {'input': 12, 'output': 8, 'total': 20}}),",
        "  ('ses_stale_stop', 'prt_stale_start', 1780532100000, 1780532100000, {'type': 'step-start'}),",
        "  ('ses_stale_stop', 'prt_stale_stop', 1780532399000, 1780532400000, {'type': 'step-finish', 'reason': 'stop', 'tokens': {'input': 12, 'output': 8, 'total': 20}}),",
        "  ('ses_resumed_after_stop', 'prt_resumed_start_1', 1780550340000, 1780550340000, {'type': 'step-start'}),",
        "  ('ses_resumed_after_stop', 'prt_resumed_stop', 1780550399000, 1780550400000, {'type': 'step-finish', 'reason': 'stop'}),",
        "  ('ses_resumed_after_stop', 'prt_resumed_start_2', 1780550460000, 1780550460000, {'type': 'step-start'}),",
        ']',
        'for session_id, part_id, created_at, updated_at, payload in parts:',
        "    cur.execute('INSERT INTO part VALUES (?, ?, ?, ?, ?)', (part_id, session_id, created_at, updated_at, json.dumps(payload)))",
        'conn.commit()',
      ].join('\n'),
    );

    const state = createEmptyState();
    const source = createSQLiteRecoverySource({ databasePath });

    await source.hydrateState(state, {
      directory: '/tmp/workspace',
      parentSessionID: 'ses_parent',
    });

    expect(state.children.ses_fresh_stop).toMatchObject({
      status: 'done',
      updatedAt: '2026-06-04T05:20:00.000Z',
      endedAt: '2026-06-04T05:20:00.000Z',
      tokens: { input: 12, output: 8, total: 20 },
    });
    expect(state.children.ses_stale_stop).toMatchObject({
      status: 'done',
      updatedAt: '2026-06-04T00:20:00.000Z',
      endedAt: '2026-06-04T00:20:00.000Z',
      tokens: { input: 12, output: 8, total: 20 },
    });
    expect(state.children.ses_resumed_after_stop).toMatchObject({
      status: 'running',
      updatedAt: '2026-06-04T05:21:00.000Z',
      endedAt: undefined,
    });
  });

  it('keeps failed step-finish recovery evidence as error', () => {
    expect(
      resolveRecoveredStatus([
        {
          type: 'step-finish',
          reason: 'failed',
          tokens: { input: 12, output: 8, total: 20 },
          time: { end: 1780532400000 },
        },
      ]),
    ).toMatchObject({
      status: 'error',
      updatedAt: '2026-06-04T00:20:00.000Z',
      endedAt: '2026-06-04T00:20:00.000Z',
      tokens: { input: 12, output: 8, total: 20 },
    });
  });

  it('keeps fresh one-text sessions running but marks short-stale never-started one-text sessions error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mrjmpl3-subagent-status-'));
    tempDirs.push(dir);
    const databasePath = join(dir, 'opencode.db');

    await createSQLiteRecoveryDatabase(
      databasePath,
      [
        'import json, sqlite3, sys',
        'path = sys.argv[1]',
        'conn = sqlite3.connect(path)',
        'cur = conn.cursor()',
        "cur.execute('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER)')",
        "cur.execute('CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)')",
        "cur.execute('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ('ses_145d5e0d2ffeVLMuOYGqU0uLr4', 'ses_parent', 'Review Monaspace options', 'general', 1780550580000, 1780550640000, 0, 0, 0, 0, 0))",
        "cur.execute('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ('ses_145d5a499ffeZF21By59epQSYl', 'ses_parent', 'Re-review Monaspace options', 'general', 1780547700000, 1780548000000, 0, 0, 0, 0, 0))",
        'initial_parts = {',
        "  'ses_145d5e0d2ffeVLMuOYGqU0uLr4': ('prt_fresh_initial_text', 1780550640000, {'id': 'prt_fresh_initial_text', 'sessionID': 'ses_145d5e0d2ffeVLMuOYGqU0uLr4', 'messageID': 'msg_monaspace_fresh', 'type': 'text', 'text': 'Review Monaspace options', 'time': {'created': 1780550640000, 'updated': 1780550640000}}),",
        "  'ses_145d5a499ffeZF21By59epQSYl': ('prt_stale_initial_text', 1780548000000, {'id': 'prt_stale_initial_text', 'sessionID': 'ses_145d5a499ffeZF21By59epQSYl', 'messageID': 'msg_monaspace_stale', 'type': 'text', 'text': 'Re-review Monaspace options', 'time': {'created': 1780548000000, 'updated': 1780548000000}}),",
        '}',
        'for session_id, (part_id, updated_at, data) in initial_parts.items():',
        "    cur.execute('INSERT INTO part VALUES (?, ?, ?, ?, ?)', (part_id, session_id, updated_at, updated_at, json.dumps(data)))",
        'conn.commit()',
      ].join('\n'),
    );

    const state = createEmptyState();
    const source = createSQLiteRecoverySource({ databasePath });
    await source.hydrateState(state, {
      directory: '/tmp/workspace',
      parentSessionID: 'ses_parent',
    });

    expect(state.children.ses_145d5e0d2ffeVLMuOYGqU0uLr4).toMatchObject({
      status: 'running',
      updatedAt: '2026-06-04T05:24:00.000Z',
      endedAt: undefined,
    });
    expect(state.children.ses_145d5a499ffeZF21By59epQSYl).toMatchObject({
      status: 'error',
      updatedAt: '2026-06-04T05:25:00.000Z',
      endedAt: '2026-06-04T05:25:00.000Z',
    });
    expect(getCounts(state)).toMatchObject({ running: 1, error: 1 });
  });

  it('hydrates terminal status and tokens from the SQLite session store', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mrjmpl3-subagent-status-'));
    tempDirs.push(dir);
    const databasePath = join(dir, 'opencode.db');

    await createSQLiteRecoveryDatabase(
      databasePath,
      [
        'import json, sqlite3, sys',
        'path = sys.argv[1]',
        'conn = sqlite3.connect(path)',
        'cur = conn.cursor()',
        "cur.execute('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER)')",
        "cur.execute('CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)')",
        "cur.execute('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ('ses_child', 'ses_parent', 'Recovered child', 'sdd-apply', 1780550100000, 1780550400000, 12, 8, 0, 0, 0))",
        'payload = json.dumps({"type": "session.status", "state": {"status": "completed"}, "tokens": {"input": 12, "output": 8, "total": 20}, "time": {"completed": 1780550400000}})',
        "cur.execute('INSERT INTO part VALUES (?, ?, ?, ?, ?)', ('prt_1', 'ses_child', 1780550399000, 1780550400000, payload))",
        'conn.commit()',
      ].join('\n'),
    );

    const state = createEmptyState();
    state.children.ses_child = {
      id: 'ses_child',
      title: 'Recovered child',
      parentID: 'ses_parent',
      source: 'session',
      status: 'running',
      startedAt: '2026-06-04T05:15:00.000Z',
      updatedAt: '2026-06-04T05:19:00.000Z',
    };
    state.children['tool:ses_child'] = {
      id: 'tool:ses_child',
      title: 'Recovered child',
      parentID: 'ses_parent',
      source: 'tool',
      targetSessionID: 'ses_child',
      status: 'running',
      startedAt: '2026-06-04T05:15:00.000Z',
      updatedAt: '2026-06-04T05:19:00.000Z',
    };

    const source = createSQLiteRecoverySource({ databasePath });
    const result = await source.hydrateState(state, {
      directory: '/tmp/workspace',
      parentSessionID: 'ses_parent',
    });

    expect(result).toEqual({
      authoritativeSessionIDs: ['ses_child'],
      changed: true,
      protectedTerminalSessionIDs: ['ses_child'],
    });
    expect(state.children.ses_child).toMatchObject({
      status: 'done',
      endedAt: '2026-06-04T05:20:00.000Z',
      tokens: { input: 12, output: 8, total: 20 },
    });
    expect(state.children['tool:ses_child']).toMatchObject({
      status: 'done',
      endedAt: '2026-06-04T05:20:00.000Z',
    });
  });

  it('treats session.status completion parts as terminal recovery evidence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mrjmpl3-subagent-status-'));
    tempDirs.push(dir);
    const databasePath = join(dir, 'opencode.db');

    await createSQLiteRecoveryDatabase(
      databasePath,
      [
        'import json, sqlite3, sys',
        'path = sys.argv[1]',
        'conn = sqlite3.connect(path)',
        'cur = conn.cursor()',
        "cur.execute('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER)')",
        "cur.execute('CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)')",
        "cur.execute('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ('ses_child', 'ses_parent', 'Recovered child', 'sdd-apply', 1780550100000, 1780550400000, 12, 8, 0, 0, 0))",
        'payload = json.dumps({"type": "session.status", "state": {"status": "completed"}, "tokens": {"input": 12, "output": 8, "total": 20}, "time": {"completed": 1780550400000}})',
        "cur.execute('INSERT INTO part VALUES (?, ?, ?, ?, ?)', ('prt_1', 'ses_child', 1780550399000, 1780550400000, payload))",
        'conn.commit()',
      ].join('\n'),
    );

    const state = createEmptyState();
    state.children.ses_child = {
      id: 'ses_child',
      title: 'Recovered child',
      parentID: 'ses_parent',
      source: 'session',
      status: 'running',
      startedAt: '2026-06-04T05:15:00.000Z',
      updatedAt: '2026-06-04T05:19:00.000Z',
    };

    const source = createSQLiteRecoverySource({ databasePath });
    await source.hydrateState(state, {
      directory: '/tmp/workspace',
      parentSessionID: 'ses_parent',
    });

    expect(state.children.ses_child).toMatchObject({
      status: 'done',
      endedAt: '2026-06-04T05:20:00.000Z',
      tokens: { input: 12, output: 8, total: 20 },
    });
  });

  it('does not terminalize generic completed part state without session-scoped evidence', () => {
    expect(
      resolveRecoveredStatus([
        {
          type: 'part.updated',
          status: 'completed',
          tokens: { input: 12, output: 8, total: 20 },
          time: { updated: 1780550400000 },
        },
      ]),
    ).toMatchObject({
      status: 'running',
      tokens: { input: 12, output: 8, total: 20 },
    });
  });

  it('keeps SQLite fallback token counts semantically partial instead of inventing totals', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mrjmpl3-subagent-status-'));
    tempDirs.push(dir);
    const databasePath = join(dir, 'opencode.db');

    await createSQLiteRecoveryDatabase(
      databasePath,
      [
        'import sqlite3, sys',
        'path = sys.argv[1]',
        'conn = sqlite3.connect(path)',
        'cur = conn.cursor()',
        "cur.execute('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER)')",
        "cur.execute('CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)')",
        "cur.execute('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ('ses_child', 'ses_parent', 'Recovered child', 'sdd-apply', 1780550100000, 1780550400000, 10, 5, 7, 100, 50))",
        'conn.commit()',
      ].join('\n'),
    );

    const state = createEmptyState();
    const source = createSQLiteRecoverySource({ databasePath });

    await source.hydrateState(state, {
      directory: '/tmp/workspace',
      parentSessionID: 'ses_parent',
    });

    expect(state.children.ses_child).toMatchObject({
      status: 'running',
      tokens: { input: 10, output: 5 },
    });
    expect(state.children.ses_child?.tokens?.total).toBeUndefined();
  });

  it('marks recovered running rows older than the default five-hour hard stale threshold as error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mrjmpl3-subagent-status-'));
    tempDirs.push(dir);
    const databasePath = join(dir, 'opencode.db');

    await createSQLiteRecoveryDatabase(
      databasePath,
      [
        'import sqlite3, sys',
        'path = sys.argv[1]',
        'conn = sqlite3.connect(path)',
        'cur = conn.cursor()',
        "cur.execute('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER)')",
        "cur.execute('CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)')",
        "cur.execute('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ('ses_child', 'ses_parent', 'Recovered child', 'sdd-apply', 1780530000000, 1780532400000, 10, 5, 0, 0, 0))",
        'conn.commit()',
      ].join('\n'),
    );

    const state = createEmptyState();
    const source = createSQLiteRecoverySource({ databasePath });

    await source.hydrateState(state, {
      directory: '/tmp/workspace',
      parentSessionID: 'ses_parent',
    });

    expect(state.children.ses_child).toMatchObject({
      status: 'error',
      updatedAt: '2026-06-04T05:25:00.000Z',
      endedAt: '2026-06-04T05:25:00.000Z',
      tokens: { input: 10, output: 5 },
    });
    expect(state.children.ses_child?.tokens?.total).toBeUndefined();
  });

  it('marks recovered running rows as error using the configured hard stale threshold', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mrjmpl3-subagent-status-'));
    tempDirs.push(dir);
    const databasePath = join(dir, 'opencode.db');

    await createSQLiteRecoveryDatabase(
      databasePath,
      [
        'import sqlite3, sys',
        'path = sys.argv[1]',
        'conn = sqlite3.connect(path)',
        'cur = conn.cursor()',
        "cur.execute('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER)')",
        "cur.execute('CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)')",
        "cur.execute('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ('ses_child', 'ses_parent', 'Recovered child', 'sdd-apply', 1780550100000, 1780550400000, 10, 5, 0, 0, 0))",
        'conn.commit()',
      ].join('\n'),
    );

    const state = createEmptyState();
    const source = createSQLiteRecoverySource({ databasePath, hardStaleAfterMs: 4 * 60_000 });

    await source.hydrateState(state, {
      directory: '/tmp/workspace',
      parentSessionID: 'ses_parent',
    });

    expect(state.children.ses_child).toMatchObject({
      status: 'error',
      updatedAt: '2026-06-04T05:25:00.000Z',
      endedAt: '2026-06-04T05:25:00.000Z',
    });
  });

  it('keeps recovered running rows running when the hard stale threshold is disabled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mrjmpl3-subagent-status-'));
    tempDirs.push(dir);
    const databasePath = join(dir, 'opencode.db');

    await createSQLiteRecoveryDatabase(
      databasePath,
      [
        'import sqlite3, sys',
        'path = sys.argv[1]',
        'conn = sqlite3.connect(path)',
        'cur = conn.cursor()',
        "cur.execute('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER)')",
        "cur.execute('CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)')",
        "cur.execute('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ('ses_child', 'ses_parent', 'Recovered child', 'sdd-apply', 1780530000000, 1780532400000, 10, 5, 0, 0, 0))",
        'conn.commit()',
      ].join('\n'),
    );

    const state = createEmptyState();
    const source = createSQLiteRecoverySource({ databasePath, hardStaleAfterMs: 0 });

    await source.hydrateState(state, {
      directory: '/tmp/workspace',
      parentSessionID: 'ses_parent',
    });

    expect(state.children.ses_child).toMatchObject({
      status: 'running',
      updatedAt: '2026-06-04T00:20:00.000Z',
      endedAt: undefined,
      tokens: { input: 10, output: 5 },
    });
  });

  it('merges SQLite row token counts with step-finish usage details when marking done', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mrjmpl3-subagent-status-'));
    tempDirs.push(dir);
    const databasePath = join(dir, 'opencode.db');

    await createSQLiteRecoveryDatabase(
      databasePath,
      [
        'import json, sqlite3, sys',
        'path = sys.argv[1]',
        'conn = sqlite3.connect(path)',
        'cur = conn.cursor()',
        "cur.execute('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER)')",
        "cur.execute('CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)')",
        "cur.execute('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ('ses_child', 'ses_parent', 'Recovered child', 'sdd-apply', 1780550100000, 1780550400000, 12, 8, 0, 0, 0))",
        'payload = json.dumps({"type": "step-finish", "reason": "stop", "tokens": {"contextPercent": 42.5}, "time": {"end": 1780550400000}})',
        "cur.execute('INSERT INTO part VALUES (?, ?, ?, ?, ?)', ('prt_1', 'ses_child', 1780550399000, 1780550400000, payload))",
        'conn.commit()',
      ].join('\n'),
    );

    const state = createEmptyState();
    state.children.ses_child = {
      id: 'ses_child',
      title: 'Recovered child',
      parentID: 'ses_parent',
      source: 'session',
      status: 'running',
      startedAt: '2026-06-04T05:15:00.000Z',
      updatedAt: '2026-06-04T05:19:00.000Z',
    };

    const source = createSQLiteRecoverySource({ databasePath });
    await source.hydrateState(state, {
      directory: '/tmp/workspace',
      parentSessionID: 'ses_parent',
    });

    expect(state.children.ses_child).toMatchObject({
      status: 'done',
      updatedAt: '2026-06-04T05:20:00.000Z',
      endedAt: '2026-06-04T05:20:00.000Z',
      tokens: { input: 12, output: 8, contextPercent: 42.5 },
    });
  });

  it('purges non-authoritative rows that are absent from SQLite recovery', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mrjmpl3-subagent-status-'));
    tempDirs.push(dir);
    const databasePath = join(dir, 'opencode.db');

    await createSQLiteRecoveryDatabase(
      databasePath,
      [
        'import sqlite3, sys',
        'path = sys.argv[1]',
        'conn = sqlite3.connect(path)',
        'cur = conn.cursor()',
        "cur.execute('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER)')",
        "cur.execute('CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)')",
        "cur.execute('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ('ses_kept', 'ses_parent', 'Kept child', 'sdd-apply', 1780550100000, 1780550400000, 1, 1, 0, 0, 0))",
        'conn.commit()',
      ].join('\n'),
    );

    const state = createEmptyState();
    state.children.ses_stale = {
      id: 'ses_stale',
      title: 'Stale child',
      parentID: 'ses_parent',
      source: 'session',
      status: 'done',
      startedAt: '2026-06-04T05:00:00.000Z',
      updatedAt: '2026-06-04T05:05:00.000Z',
      endedAt: '2026-06-04T05:05:00.000Z',
    };

    const source = createSQLiteRecoverySource({ databasePath });
    await source.hydrateState(state, {
      directory: '/tmp/workspace',
      parentSessionID: 'ses_parent',
    });

    expect(state.children.ses_stale).toBeUndefined();
    expect(state.purgedSessionIDs.ses_stale).toBe(true);
    expect(state.children.ses_kept).toMatchObject({
      status: 'running',
      title: 'Kept child',
    });
  });

  it('lets recovered terminal state win over newer cached running evidence', () => {
    const state = createEmptyState();
    state.children.ses_child = {
      id: 'ses_child',
      title: 'Live child',
      parentID: 'ses_parent',
      source: 'session',
      status: 'running',
      startedAt: '2026-06-04T11:55:00.000Z',
      updatedAt: '2026-06-04T12:01:00.000Z',
      color: 'yellow',
    };

    const result = applyRecoveredChildren(
      state,
      [
        {
          id: 'ses_child',
          title: 'Recovered child',
          parentID: 'ses_parent',
          source: 'session',
          targetSessionID: 'ses_child',
          status: 'done',
          startedAt: '2026-06-04T11:55:00.000Z',
          updatedAt: '2026-06-04T12:00:00.000Z',
          endedAt: '2026-06-04T12:00:00.000Z',
        },
      ],
      ['ses_child'],
      'ses_parent',
    );

    expect(result.changed).toBe(true);
    expect(state.children.ses_child).toMatchObject({
      status: 'done',
      color: 'green',
      updatedAt: '2026-06-04T12:00:00.000Z',
      endedAt: '2026-06-04T12:00:00.000Z',
      title: 'Recovered child',
    });
  });

  it('does not purge newer live running rows missing from provisional recovery results', () => {
    const state = createEmptyState();
    state.children.ses_live = {
      id: 'ses_live',
      title: 'Live child',
      parentID: 'ses_parent',
      source: 'session',
      targetSessionID: 'ses_live',
      status: 'running',
      startedAt: '2026-06-04T11:55:00.000Z',
      updatedAt: '2026-06-04T12:01:00.000Z',
      color: 'yellow',
    };

    applyRecoveredChildren(
      state,
      [
        {
          id: 'ses_recovered',
          title: 'Recovered child',
          parentID: 'ses_parent',
          source: 'session',
          targetSessionID: 'ses_recovered',
          status: 'done',
          startedAt: '2026-06-04T11:40:00.000Z',
          updatedAt: '2026-06-04T11:50:00.000Z',
          endedAt: '2026-06-04T11:50:00.000Z',
        },
      ],
      ['ses_recovered'],
      'ses_parent',
    );

    expect(state.children.ses_live).toMatchObject({
      status: 'running',
      updatedAt: '2026-06-04T12:01:00.000Z',
    });
    expect(state.purgedSessionIDs.ses_live).toBeUndefined();
  });

  it('ignores malformed latest-part payloads instead of aborting SQLite recovery', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mrjmpl3-subagent-status-'));
    tempDirs.push(dir);
    const databasePath = join(dir, 'opencode.db');

    await createSQLiteRecoveryDatabase(
      databasePath,
      [
        'import sqlite3, sys',
        'path = sys.argv[1]',
        'conn = sqlite3.connect(path)',
        'cur = conn.cursor()',
        "cur.execute('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER)')",
        "cur.execute('CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)')",
        "cur.execute('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ('ses_child', 'ses_parent', 'Recovered child', 'sdd-apply', 1780550100000, 1780550400000, 12, 8, 0, 0, 0))",
        "cur.execute('INSERT INTO part VALUES (?, ?, ?, ?, ?)', ('prt_1', 'ses_child', 1780550399000, 1780550400000, '{bad json'))",
        'conn.commit()',
      ].join('\n'),
    );

    const state = createEmptyState();
    const source = createSQLiteRecoverySource({ databasePath });

    const result = await source.hydrateState(state, {
      directory: '/tmp/workspace',
      parentSessionID: 'ses_parent',
    });

    expect(result).toEqual({
      authoritativeSessionIDs: ['ses_child'],
      changed: true,
      protectedTerminalSessionIDs: [],
    });
    expect(state.children.ses_child).toMatchObject({
      status: 'running',
      updatedAt: '2026-06-04T05:20:00.000Z',
      endedAt: undefined,
      tokens: { input: 12, output: 8 },
    });
    expect(state.children.ses_child?.tokens?.total).toBeUndefined();
  });

  it('falls back to session updatedAt when terminal recovery payload omits terminal time fields', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mrjmpl3-subagent-status-'));
    tempDirs.push(dir);
    const databasePath = join(dir, 'opencode.db');

    await createSQLiteRecoveryDatabase(
      databasePath,
      [
        'import json, sqlite3, sys',
        'path = sys.argv[1]',
        'conn = sqlite3.connect(path)',
        'cur = conn.cursor()',
        "cur.execute('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER)')",
        "cur.execute('CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)')",
        "cur.execute('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ('ses_child', 'ses_parent', 'Recovered child', 'sdd-apply', 1780550100000, 1780550400000, 12, 8, 0, 0, 0))",
        'payload = json.dumps({"type": "session.status", "state": {"status": "completed"}})',
        "cur.execute('INSERT INTO part VALUES (?, ?, ?, ?, ?)', ('prt_1', 'ses_child', 1780550399000, 1780550400000, payload))",
        'conn.commit()',
      ].join('\n'),
    );

    const state = createEmptyState();
    const source = createSQLiteRecoverySource({ databasePath });

    await source.hydrateState(state, {
      directory: '/tmp/workspace',
      parentSessionID: 'ses_parent',
    });

    expect(state.children.ses_child).toMatchObject({
      status: 'done',
      updatedAt: '2026-06-04T05:20:00.000Z',
      endedAt: '2026-06-04T05:20:00.000Z',
      tokens: { input: 12, output: 8 },
    });
    expect(state.children.ses_child?.tokens?.total).toBeUndefined();
  });
});

describe('debug gating for sqlite recovery console.log replacements', () => {
  afterEach(() => {
    setDebugEnabled(false);
    vi.restoreAllMocks();
  });

  it('does not call console.log for hydrateState skipping when debug is disabled', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const state = createEmptyState();
    const source = createSQLiteRecoverySource();

    setDebugEnabled(false);
    await source.hydrateState(state, { directory: '/tmp' });

    expect(console.log).not.toHaveBeenCalled();
  });

  it('calls console.log for hydrateState skipping when debug is enabled', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const state = createEmptyState();
    const source = createSQLiteRecoverySource();

    setDebugEnabled(true);
    await source.hydrateState(state, { directory: '/tmp' });

    expect(console.log).toHaveBeenCalled();
  });
});

describe('mergeTokens cleanup', () => {
  it('sqlite.ts uses mergeSubagentTokens from domain/tokens instead of a local mergeTokens', async () => {
    const source = await readFile(new URL('../src/infrastructure/recovery/sqlite.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(/const mergeTokens\s*=\s*\(/);
    expect(source).toMatch(/import\s*\{[^}]*mergeSubagentTokens[^}]*\}\s*from\s['"]\.\.\/\.\.\/domain\/tokens\.ts['"]/);
  });
});
