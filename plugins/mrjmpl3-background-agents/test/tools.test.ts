import { describe, expect, it, vi } from 'vitest';

import { createDelegate, createDelegationList, createDelegationRead } from '../src/tools.ts';
import type { DelegationManager } from '../src/manager.ts';

function createToolContext(overrides: Record<string, unknown> = {}) {
  return {
    sessionID: 'parent-session',
    messageID: 'parent-message',
    agent: 'build',
    directory: '/project',
    worktree: '/project',
    abort: new AbortController().signal,
    metadata: vi.fn(),
    ask: vi.fn(),
    ...overrides,
  };
}

describe('delegation tools', () => {
  it('returns hook-contract guidance instead of throwing when delegate has no sessionID', async () => {
    const manager = { delegate: vi.fn(), getPendingCount: vi.fn() } as unknown as DelegationManager;
    const delegate = createDelegate(manager);

    const result = await delegate.execute(
      { prompt: 'Inspect the codebase', agent: 'explore' },
      createToolContext({ sessionID: undefined }) as never,
    );

    expect(result).toBe('❌ delegate requires sessionID. This is a system error.');
    expect(manager.delegate).not.toHaveBeenCalled();
  });

  it('returns validation errors from the manager as user-facing guidance', async () => {
    const manager = {
      delegate: vi.fn().mockRejectedValue(new Error('Agent "missing" not found.')),
      getPendingCount: vi.fn(),
    } as unknown as DelegationManager;
    const delegate = createDelegate(manager);

    const result = await delegate.execute(
      { prompt: 'Inspect the codebase', agent: 'missing' },
      createToolContext() as never,
    );

    expect(result).toContain('❌ Delegation failed:');
    expect(result).toContain('Agent "missing" not found.');
  });

  it('does not call delegation_read manager logic without a sessionID', async () => {
    const manager = { readOutput: vi.fn() } as unknown as DelegationManager;
    const read = createDelegationRead(manager);

    const result = await read.execute({ id: 'valid-blue-fox' }, createToolContext({ sessionID: undefined }) as never);

    expect(result).toBe('❌ delegation_read requires sessionID. This is a system error.');
    expect(manager.readOutput).not.toHaveBeenCalled();
  });

  it('renders an empty delegation list without leaking undefined data', async () => {
    const manager = { listDelegations: vi.fn().mockResolvedValue([]) } as unknown as DelegationManager;
    const list = createDelegationList(manager);

    const result = await list.execute({}, createToolContext() as never);

    expect(result).toBe('No delegations found for this session.');
  });
});
