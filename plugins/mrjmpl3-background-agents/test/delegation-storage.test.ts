import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DelegationStorage } from '../src/delegation-storage.ts';
import type { Delegation } from '../src/types.ts';

function createDelegation(overrides: Partial<Delegation> = {}): Delegation {
  return {
    id: 'valid-blue-fox',
    sessionID: 'delegation-session',
    parentSessionID: 'parent-session',
    parentMessageID: 'parent-message',
    parentAgent: 'build',
    prompt: 'Inspect the project',
    agent: 'explore',
    status: 'complete',
    startedAt: new Date('2026-01-01T00:00:00.000Z'),
    completedAt: new Date('2026-01-01T00:01:00.000Z'),
    progress: {
      toolCalls: 0,
      lastUpdate: new Date('2026-01-01T00:01:00.000Z'),
    },
    ...overrides,
  };
}

describe('DelegationStorage', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'delegation-storage-test-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('rejects malformed resolved root session IDs before creating storage paths', async () => {
    const escapedRootDir = path.join(path.dirname(baseDir), 'escaped-root');
    const storage = new DelegationStorage(baseDir, async () => '../escaped-root');

    await expect(storage.persistOutput(createDelegation(), 'Output')).rejects.toThrow('Invalid root session ID');
    await expect(fs.stat(escapedRootDir)).rejects.toThrow();
  });

  it('rejects malformed input session IDs before resolving storage paths', async () => {
    const resolveRootSessionID = vi.fn().mockResolvedValue('parent-session');
    const storage = new DelegationStorage(baseDir, resolveRootSessionID);

    await expect(storage.readOutput('../parent-session', 'valid-blue-fox')).rejects.toThrow('Invalid session ID');
    expect(resolveRootSessionID).not.toHaveBeenCalled();
  });

  it('validates delegation IDs internally when persisting output', async () => {
    const storage = new DelegationStorage(baseDir, async (sessionID) => sessionID);

    await expect(storage.persistOutput(createDelegation({ id: '../secret' }), 'Output')).rejects.toThrow(
      'Invalid delegation ID',
    );
    await expect(fs.stat(path.join(baseDir, 'secret.md'))).rejects.toThrow();
  });

  it('keeps persisted outputs isolated by resolved root session', async () => {
    const storage = new DelegationStorage(baseDir, async (sessionID) => {
      const rootsBySession: Record<string, string> = {
        'session-a-child': 'session-a-root',
        'session-b-child': 'session-b-root',
      };

      return rootsBySession[sessionID] ?? sessionID;
    });

    await storage.persistOutput(createDelegation({ parentSessionID: 'session-a-child' }), 'Session A output');
    await storage.persistOutput(createDelegation({ parentSessionID: 'session-b-child' }), 'Session B output');

    await expect(storage.readOutput('session-a-child', 'valid-blue-fox')).resolves.toContain('Session A output');
    await expect(storage.readOutput('session-b-child', 'valid-blue-fox')).resolves.toContain('Session B output');
  });
});
