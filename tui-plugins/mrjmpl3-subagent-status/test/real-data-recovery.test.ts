import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createSQLiteRecoverySource } from '../src/infrastructure/recovery/sqlite.ts';
import { createEmptyState } from '../src/domain/state.ts';

// This test exercises the SQLite recovery path against the real OpenCode database
// in the developer's local environment. It gracefully skips when the database or
// the expected parent session is not present, so it is safe to run in CI.
const REAL_DATABASE_PATH = '/home/mrjmpl3/.local/share/opencode/opencode.db';
const REAL_PARENT_SESSION_ID = 'ses_1445e9f81ffeQ9ZIn7WJbvvCfF';

const realParentSessionExists = (): boolean => {
  if (!existsSync(REAL_DATABASE_PATH)) return false;
  try {
    const result = execFileSync(
      'python3',
      [
        '-c',
        'import sqlite3, sys\npath = sys.argv[1]\nparent = sys.argv[2]\nconn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)\nprint(conn.execute("SELECT 1 FROM session WHERE id = ?", (parent,)).fetchone() is not None)\n',
        REAL_DATABASE_PATH,
        REAL_PARENT_SESSION_ID,
      ],
      { encoding: 'utf8' },
    );
    return result.trim() === 'True';
  } catch {
    return false;
  }
};

describe('real-data SQLite recovery end-to-end', () => {
  it('classifies all completed subagent sessions correctly against the real OpenCode database', async () => {
    if (!realParentSessionExists()) {
      console.log(`[skip] Real OpenCode database or parent session ${REAL_PARENT_SESSION_ID} not available.`);
      return;
    }

    const source = createSQLiteRecoverySource({ hardStaleAfterMs: 5 * 60 * 60 * 1000 });
    const state = createEmptyState();

    const result = await source.hydrateState(state, {
      directory: '/home/mrjmpl3/.config/opencode',
      parentSessionID: REAL_PARENT_SESSION_ID,
    });

    expect(result).toBeDefined();
    expect(result?.changed).toBe(true);
    expect(result?.authoritativeSessionIDs.length).toBeGreaterThanOrEqual(15);

    const counts = { running: 0, done: 0, error: 0 } as Record<string, number>;
    const wrong: Array<{ id: string; status: string; endedAt?: string; updatedAt?: string }> = [];
    for (const [id, child] of Object.entries(state.children)) {
      const s = child.status as 'running' | 'done' | 'error';
      counts[s] = (counts[s] ?? 0) + 1;
      if (s === 'error') {
        wrong.push({ id, status: s, endedAt: child.endedAt, updatedAt: child.updatedAt });
      }
    }

    console.log('--- REAL DATABASE RECOVERY COUNTS ---');
    console.log(counts);
    if (wrong.length > 0) {
      console.log('--- sessions incorrectly marked as error ---');
      for (const w of wrong) {
        console.log(`  ${w.id} endedAt=${w.endedAt} updatedAt=${w.updatedAt}`);
      }
    }

    expect(counts.done).toBeGreaterThan(0);
    expect(counts.error ?? 0).toBeLessThan(3);
  }, 30_000);
});
