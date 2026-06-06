import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSQLiteRecoverySource } from '../src/infrastructure/recovery/sqlite.ts';
import { createEmptyState } from '../src/domain/state.ts';
import { applyRecoveredChildren } from '../src/infrastructure/recovery.ts';

async function createSQLiteRecoveryDatabase(path: string, script: string): Promise<void> {
  execFileSync('python3', ['-c', script, path], { encoding: 'utf8' });
}

describe('sqlite recovery source', () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-04T05:25:00.000Z'));
  });

  afterEach(async () => {
    vi.useRealTimers();

    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    }
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
        'payload = json.dumps({"type": "step-finish", "reason": "stop", "tokens": {"input": 12, "output": 8, "total": 20}, "time": {"end": 1780550400000}})',
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

  it('keeps newer live running evidence when recovered terminal state is older', () => {
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
      status: 'running',
      color: 'yellow',
      updatedAt: '2026-06-04T12:01:00.000Z',
      endedAt: undefined,
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
});
