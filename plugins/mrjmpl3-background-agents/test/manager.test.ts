import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DelegationManager } from '../src/manager.ts';
import type { Logger } from '../src/logger.ts';
import type { OpencodeClient } from '../src/types.ts';

function createLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createClient(overrides: Record<string, unknown> = {}): OpencodeClient {
  const client = {
    app: {
      agents: vi.fn().mockResolvedValue({ data: [{ name: 'explore', mode: 'subagent' }] }),
      log: vi.fn().mockResolvedValue({}),
    },
    config: {
      get: vi.fn().mockResolvedValue({ data: {} }),
    },
    session: {
      create: vi.fn().mockResolvedValue({ data: { id: 'delegation-session' } }),
      delete: vi.fn().mockResolvedValue({}),
      get: vi.fn().mockResolvedValue({ data: { id: 'parent-session' } }),
      messages: vi.fn().mockResolvedValue({ data: [] }),
      prompt: vi.fn().mockResolvedValue({ data: {} }),
    },
    ...overrides,
  };

  return client as unknown as OpencodeClient;
}

function inspectManagerState(manager: DelegationManager): {
  delegations: Map<string, unknown>;
  pendingParentCount: number;
} {
  const inspected = manager as unknown as { delegations: Map<string, unknown> };

  return {
    delegations: inspected.delegations,
    pendingParentCount: manager.getPendingParentCount(),
  };
}

async function expectNoDebugLogFile(baseDir: string): Promise<void> {
  await expect(fs.access(path.join(baseDir, 'background-agents-debug.log'))).rejects.toThrow();
}

describe('DelegationManager', () => {
  let baseDir: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'background-agents-test-'));
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('rejects malformed delegation IDs before touching filesystem paths', async () => {
    const client = createClient();
    const manager = new DelegationManager(client, baseDir, createLogger());
    await fs.writeFile(path.join(baseDir, 'secret.md'), 'outside-session-data', 'utf8');

    await expect(manager.readOutput('parent-session', '../secret')).rejects.toThrow('Invalid delegation ID');
  });

  it('ignores malformed persisted filenames when listing delegations', async () => {
    const client = createClient();
    const manager = new DelegationManager(client, baseDir, createLogger());
    const sessionDir = path.join(baseDir, 'parent-session');
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, 'valid-blue-fox.md'),
      '# Valid task\n\nDescription\n\n**Agent:** explore',
      'utf8',
    );
    await fs.writeFile(path.join(sessionDir, '..-invalid.md'), '# Invalid task', 'utf8');

    const delegations = await manager.listDelegations('parent-session');

    expect(delegations).toEqual([
      expect.objectContaining({ id: 'valid-blue-fox', title: 'Valid task', agent: 'explore' }),
    ]);
  });

  it('rejects malformed parent session IDs before creating delegation side effects', async () => {
    const client = createClient();
    const manager = new DelegationManager(client, baseDir, createLogger());

    await expect(
      manager.delegate({
        parentSessionID: '../parent-session',
        parentMessageID: 'parent-message',
        parentAgent: 'build',
        prompt: 'Inspect the project',
        agent: 'explore',
      }),
    ).rejects.toThrow('Invalid session ID');

    const state = inspectManagerState(manager);

    expect(client.app.agents).not.toHaveBeenCalled();
    expect(client.session.create).not.toHaveBeenCalled();
    expect(client.session.get).not.toHaveBeenCalled();
    expect(client.session.prompt).not.toHaveBeenCalled();
    expect(state.delegations.size).toBe(0);
    expect(state.pendingParentCount).toBe(0);
    await expectNoDebugLogFile(baseDir);
  });

  it('rejects malformed resolved root session IDs before creating delegation side effects', async () => {
    const client = createClient({
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: 'delegation-session' } }),
        delete: vi.fn().mockResolvedValue({}),
        get: vi.fn().mockImplementation(({ path: sessionPath }: { path: { id: string } }) => {
          if (sessionPath.id === 'child-session') {
            return Promise.resolve({ data: { id: 'child-session', parentID: '../root-session' } });
          }

          return Promise.resolve({ data: { id: sessionPath.id } });
        }),
        messages: vi.fn().mockResolvedValue({ data: [] }),
        prompt: vi.fn().mockResolvedValue({ data: {} }),
      },
    });
    const manager = new DelegationManager(client, baseDir, createLogger());

    await expect(
      manager.delegate({
        parentSessionID: 'child-session',
        parentMessageID: 'parent-message',
        parentAgent: 'build',
        prompt: 'Inspect the project',
        agent: 'explore',
      }),
    ).rejects.toThrow('Invalid root session ID');

    const state = inspectManagerState(manager);

    expect(client.app.agents).toHaveBeenCalledTimes(1);
    expect(client.session.create).not.toHaveBeenCalled();
    expect(client.session.prompt).not.toHaveBeenCalled();
    expect(state.delegations.size).toBe(0);
    expect(state.pendingParentCount).toBe(0);
    await expectNoDebugLogFile(baseDir);
  });

  it('rejects unknown agents before creating session, tracking, prompt, or debug side effects', async () => {
    const client = createClient();
    const manager = new DelegationManager(client, baseDir, createLogger());

    await expect(
      manager.delegate({
        parentSessionID: 'parent-session',
        parentMessageID: 'parent-message',
        parentAgent: 'build',
        prompt: 'Inspect the project',
        agent: 'missing-agent',
      }),
    ).rejects.toThrow('Agent "missing-agent" not found');

    const state = inspectManagerState(manager);

    expect(client.app.agents).toHaveBeenCalledTimes(1);
    expect(client.session.get).not.toHaveBeenCalled();
    expect(client.session.create).not.toHaveBeenCalled();
    expect(client.session.prompt).not.toHaveBeenCalled();
    expect(state.delegations.size).toBe(0);
    expect(state.pendingParentCount).toBe(0);
    await expectNoDebugLogFile(baseDir);
  });

  it('does not leave tracked running delegations when storage preparation fails before prompt startup', async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
    await fs.writeFile(baseDir, 'not-a-directory', 'utf8');

    const client = createClient();
    const manager = new DelegationManager(client, baseDir, createLogger());

    await expect(
      manager.delegate({
        parentSessionID: 'parent-session',
        parentMessageID: 'parent-message',
        parentAgent: 'build',
        prompt: 'Inspect the project',
        agent: 'explore',
      }),
    ).rejects.toThrow();

    const state = inspectManagerState(manager);

    expect(client.session.create).toHaveBeenCalledTimes(1);
    expect(client.session.prompt).not.toHaveBeenCalled();
    expect(state.delegations.size).toBe(0);
    expect(state.pendingParentCount).toBe(0);
    expect(manager.getRunningDelegations()).toEqual([]);
  });

  it('does not list in-memory delegations from other session roots', async () => {
    const client = createClient({
      session: {
        create: vi
          .fn()
          .mockResolvedValueOnce({ data: { id: 'delegation-one' } })
          .mockResolvedValueOnce({ data: { id: 'delegation-two' } }),
        delete: vi.fn().mockResolvedValue({}),
        get: vi.fn().mockImplementation(({ path: sessionPath }: { path: { id: string } }) => {
          const parentBySession: Record<string, string> = {
            'session-a-child': 'session-a',
          };

          return Promise.resolve({ data: { id: sessionPath.id, parentID: parentBySession[sessionPath.id] } });
        }),
        messages: vi.fn().mockResolvedValue({ data: [] }),
        prompt: vi.fn().mockResolvedValue({ data: {} }),
      },
    });
    const manager = new DelegationManager(client, baseDir, createLogger());

    const sessionADelegation = await manager.delegate({
      parentSessionID: 'session-a',
      parentMessageID: 'parent-message-a',
      parentAgent: 'build',
      prompt: 'Session A task',
      agent: 'explore',
    });
    const sessionBDelegation = await manager.delegate({
      parentSessionID: 'session-b',
      parentMessageID: 'parent-message-b',
      parentAgent: 'build',
      prompt: 'Session B task',
      agent: 'explore',
    });

    const delegations = await manager.listDelegations('session-a-child');

    expect(delegations).toEqual([expect.objectContaining({ id: sessionADelegation.id, status: 'running' })]);
    expect(delegations).not.toContainEqual(expect.objectContaining({ id: sessionBDelegation.id }));
  });

  it('selects sibling-root running delegations for compaction without leaking other roots', async () => {
    const parentBySession: Record<string, string | undefined> = {
      'root-session': undefined,
      'sibling-session': 'root-session',
      'child-session': 'root-session',
      'other-root-session': undefined,
      'other-child-session': 'other-root-session',
    };
    const client = createClient({
      session: {
        create: vi
          .fn()
          .mockResolvedValueOnce({ data: { id: 'delegation-from-child' } })
          .mockResolvedValueOnce({ data: { id: 'delegation-from-other-root' } }),
        delete: vi.fn().mockResolvedValue({}),
        get: vi
          .fn()
          .mockImplementation(({ path: sessionPath }: { path: { id: string } }) =>
            Promise.resolve({ data: { id: sessionPath.id, parentID: parentBySession[sessionPath.id] } }),
          ),
        messages: vi.fn().mockResolvedValue({ data: [] }),
        prompt: vi.fn().mockResolvedValue({ data: {} }),
      },
    });
    const manager = new DelegationManager(client, baseDir, createLogger());

    const sameRootDelegation = await manager.delegate({
      parentSessionID: 'child-session',
      parentMessageID: 'parent-message-a',
      parentAgent: 'build',
      prompt: 'Same root task',
      agent: 'explore',
    });
    const otherRootDelegation = await manager.delegate({
      parentSessionID: 'other-child-session',
      parentMessageID: 'parent-message-b',
      parentAgent: 'build',
      prompt: 'Other root task',
      agent: 'explore',
    });

    const runningDelegations = await manager.getRunningDelegationsForSession('sibling-session');

    expect(runningDelegations).toEqual([expect.objectContaining({ id: sameRootDelegation.id, status: 'running' })]);
    expect(runningDelegations).not.toContainEqual(expect.objectContaining({ id: otherRootDelegation.id }));
  });

  it('does not delete or cancel in-memory delegations from another session root', async () => {
    const client = createClient({
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: 'delegation-session-a' } }),
        delete: vi.fn().mockResolvedValue({}),
        get: vi
          .fn()
          .mockImplementation(({ path: sessionPath }: { path: { id: string } }) =>
            Promise.resolve({ data: { id: sessionPath.id } }),
          ),
        messages: vi.fn().mockResolvedValue({ data: [] }),
        prompt: vi.fn().mockResolvedValue({ data: {} }),
      },
    });
    const manager = new DelegationManager(client, baseDir, createLogger());

    const sessionADelegation = await manager.delegate({
      parentSessionID: 'session-a',
      parentMessageID: 'parent-message-a',
      parentAgent: 'build',
      prompt: 'Session A task',
      agent: 'explore',
    });

    const deleted = await manager.deleteDelegation('session-b', sessionADelegation.id);
    const sessionADelegations = await manager.listDelegations('session-a');

    expect(deleted).toBe(false);
    expect(client.session.delete).not.toHaveBeenCalled();
    expect(sessionADelegations).toEqual([expect.objectContaining({ id: sessionADelegation.id, status: 'running' })]);
  });

  it('treats in-memory output from another session root as not found without waiting', async () => {
    const client = createClient({
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: 'delegation-session-a' } }),
        delete: vi.fn().mockResolvedValue({}),
        get: vi
          .fn()
          .mockImplementation(({ path: sessionPath }: { path: { id: string } }) =>
            Promise.resolve({ data: { id: sessionPath.id } }),
          ),
        messages: vi.fn().mockResolvedValue({ data: [] }),
        prompt: vi.fn().mockResolvedValue({ data: {} }),
      },
    });
    const manager = new DelegationManager(client, baseDir, createLogger());
    const debugLog = vi.spyOn(manager, 'debugLog');

    const sessionADelegation = await manager.delegate({
      parentSessionID: 'session-a',
      parentMessageID: 'parent-message-a',
      parentAgent: 'build',
      prompt: 'Session A task',
      agent: 'explore',
    });

    await expect(manager.readOutput('session-b', sessionADelegation.id)).rejects.toThrow(
      `Delegation "${sessionADelegation.id}" not found.`,
    );
    expect(debugLog).not.toHaveBeenCalledWith(
      expect.stringContaining(`readOutput: waiting for delegation ${sessionADelegation.id}`),
    );
  });

  it('persists a completion fallback when the delegated session has no messages', async () => {
    const client = createClient();
    const manager = new DelegationManager(client, baseDir, createLogger());
    const delegation = await manager.delegate({
      parentSessionID: 'parent-session',
      parentMessageID: 'parent-message',
      parentAgent: 'build',
      prompt: 'Inspect the project',
      agent: 'explore',
    });

    await manager.handleSessionIdle(delegation.sessionID);
    const output = await manager.readOutput('parent-session', delegation.id);

    expect(output).toContain(`Delegation "${delegation.id}" completed but produced no output.`);
    expect(output).toContain('**Status:** complete');
  });

  it('persists prompt errors before notifying the parent session', async () => {
    vi.useRealTimers();

    let delegationId = '';
    const parentNotificationSawPersistedOutput: boolean[] = [];
    const client = createClient({
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: 'delegation-session' } }),
        delete: vi.fn().mockResolvedValue({}),
        get: vi.fn().mockResolvedValue({ data: { id: 'parent-session' } }),
        messages: vi.fn().mockResolvedValue({ data: [] }),
        prompt: vi.fn().mockImplementation(async ({ path: promptPath }: { path: { id: string } }) => {
          if (promptPath.id === 'delegation-session') {
            throw new Error('prompt failed');
          }

          const outputPath = path.join(baseDir, 'parent-session', `${delegationId}.md`);

          try {
            const output = await fs.readFile(outputPath, 'utf8');
            parentNotificationSawPersistedOutput.push(output.includes('Error: prompt failed'));
          } catch {
            parentNotificationSawPersistedOutput.push(false);
          }

          return { data: {} };
        }),
      },
    });
    const manager = new DelegationManager(client, baseDir, createLogger());

    const delegation = await manager.delegate({
      parentSessionID: 'parent-session',
      parentMessageID: 'parent-message',
      parentAgent: 'build',
      prompt: 'Inspect the project',
      agent: 'explore',
    });
    delegationId = delegation.id;

    await vi.waitFor(() => {
      expect(parentNotificationSawPersistedOutput).toEqual([true, true]);
    });
  });

  it('batches parent notifications until all active delegations for the same parent complete', async () => {
    const client = createClient({
      session: {
        create: vi
          .fn()
          .mockResolvedValueOnce({ data: { id: 'delegation-one' } })
          .mockResolvedValueOnce({ data: { id: 'delegation-two' } }),
        delete: vi.fn().mockResolvedValue({}),
        get: vi.fn().mockResolvedValue({ data: { id: 'parent-session' } }),
        messages: vi.fn().mockResolvedValue({ data: [] }),
        prompt: vi.fn().mockResolvedValue({ data: {} }),
      },
    });
    const manager = new DelegationManager(client, baseDir, createLogger());

    const first = await manager.delegate({
      parentSessionID: 'parent-session',
      parentMessageID: 'parent-message',
      parentAgent: 'build',
      prompt: 'First task',
      agent: 'explore',
    });
    const second = await manager.delegate({
      parentSessionID: 'parent-session',
      parentMessageID: 'parent-message',
      parentAgent: 'build',
      prompt: 'Second task',
      agent: 'explore',
    });

    await manager.handleSessionIdle(first.sessionID);
    const parentPromptCallsAfterFirst = vi
      .mocked(client.session.prompt)
      .mock.calls.filter(([input]) => input.path.id === 'parent-session');

    await manager.handleSessionIdle(second.sessionID);
    const parentPromptCallsAfterSecond = vi
      .mocked(client.session.prompt)
      .mock.calls.filter(([input]) => input.path.id === 'parent-session');
    const allCompleteCalls = parentPromptCallsAfterSecond.filter(([input]) => input.body?.noReply === false);

    expect(parentPromptCallsAfterFirst).toHaveLength(1);
    expect(parentPromptCallsAfterFirst[0]?.[0].body?.noReply).toBe(true);
    expect(parentPromptCallsAfterSecond).toHaveLength(3);
    expect(allCompleteCalls).toHaveLength(1);
  });

  it('allows remaining tracked delegations to emit all-complete after another delegation is deleted', async () => {
    const client = createClient({
      session: {
        create: vi
          .fn()
          .mockResolvedValueOnce({ data: { id: 'delegation-one' } })
          .mockResolvedValueOnce({ data: { id: 'delegation-two' } }),
        delete: vi.fn().mockResolvedValue({}),
        get: vi.fn().mockResolvedValue({ data: { id: 'parent-session' } }),
        messages: vi.fn().mockResolvedValue({ data: [] }),
        prompt: vi.fn().mockResolvedValue({ data: {} }),
      },
    });
    const manager = new DelegationManager(client, baseDir, createLogger());

    const deletedDelegation = await manager.delegate({
      parentSessionID: 'parent-session',
      parentMessageID: 'parent-message',
      parentAgent: 'build',
      prompt: 'Deleted task',
      agent: 'explore',
    });
    const remainingDelegation = await manager.delegate({
      parentSessionID: 'parent-session',
      parentMessageID: 'parent-message',
      parentAgent: 'build',
      prompt: 'Remaining task',
      agent: 'explore',
    });

    await manager.deleteDelegation('parent-session', deletedDelegation.id);

    expect(manager.getPendingCount('parent-session')).toBe(1);

    await manager.handleSessionIdle(remainingDelegation.sessionID);

    const parentPromptCalls = vi
      .mocked(client.session.prompt)
      .mock.calls.filter(([input]) => input.path.id === 'parent-session');
    const allCompleteCalls = parentPromptCalls.filter(([input]) => input.body?.noReply === false);

    expect(parentPromptCalls).toHaveLength(2);
    expect(allCompleteCalls).toHaveLength(1);
    expect(manager.getPendingCount('parent-session')).toBe(0);
  });
});
