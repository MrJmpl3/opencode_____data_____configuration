import { describe, expect, it, vi } from 'vitest';

import {
  dispatchDelegationNotifications,
  formatAllCompleteNotification,
  formatCompletionNotification,
  PendingDelegationNotifications,
} from '../src/delegation-notifications.ts';
import type { Delegation, OpencodeClient } from '../src/types.ts';

type PromptResult = Awaited<ReturnType<OpencodeClient['session']['prompt']>>;

function createClient(): OpencodeClient {
  const client = {
    session: {
      prompt: vi.fn().mockResolvedValue({ data: {} }),
    },
  };

  return client as unknown as OpencodeClient;
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;

  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

function createDelegation(overrides: Partial<Delegation> = {}): Delegation {
  return {
    id: 'blue-fox',
    sessionID: 'delegation-session',
    parentSessionID: 'parent-session',
    parentMessageID: 'parent-message',
    parentAgent: 'build',
    prompt: 'Inspect the project',
    agent: 'explore',
    status: 'complete',
    startedAt: new Date('2026-01-01T00:00:00.000Z'),
    progress: {
      toolCalls: 0,
      lastUpdate: new Date('2026-01-01T00:00:00.000Z'),
    },
    ...overrides,
  };
}

describe('delegation notifications', () => {
  it('formats the per-delegation completion notification', () => {
    expect(formatCompletionNotification(createDelegation())).toBe(`[TASK NOTIFICATION]
ID: blue-fox
Status: complete
Use delegation_read(id) to retrieve the full result.`);
  });

  it('formats the all-complete notification', () => {
    expect(formatAllCompleteNotification()).toBe('[TASK NOTIFICATION] All delegations complete.');
  });

  it('tracks pending delegation completion per parent session', () => {
    const tracker = new PendingDelegationNotifications();

    expect(tracker.track('parent-session', 'first')).toBe(1);
    expect(tracker.track('parent-session', 'second')).toBe(2);
    expect(tracker.count('parent-session')).toBe(2);

    expect(tracker.complete('parent-session', 'first')).toEqual({ allComplete: false, remaining: 1 });
    expect(tracker.complete('parent-session', 'second')).toEqual({ allComplete: true, remaining: 0 });
    expect(tracker.count('parent-session')).toBe(0);
  });

  it('keeps remaining delegation state when an unknown delegation completes for a tracked parent', () => {
    const tracker = new PendingDelegationNotifications();

    tracker.track('parent-session', 'known');

    expect(tracker.complete('parent-session', 'unknown')).toEqual({ allComplete: false, remaining: 1 });
    expect(tracker.count('parent-session')).toBe(1);
    expect(tracker.totalParents()).toBe(1);
  });

  it('treats duplicate completion after parent cleanup as all complete', () => {
    const tracker = new PendingDelegationNotifications();

    tracker.track('parent-session', 'only');

    expect(tracker.complete('parent-session', 'only')).toEqual({ allComplete: true, remaining: 0 });
    expect(tracker.complete('parent-session', 'only')).toEqual({ allComplete: true, remaining: 0 });
    expect(tracker.count('parent-session')).toBe(0);
    expect(tracker.totalParents()).toBe(0);
  });

  it('treats completion for an unknown parent as all complete', () => {
    const tracker = new PendingDelegationNotifications();

    expect(tracker.complete('missing-parent', 'unknown')).toEqual({ allComplete: true, remaining: 0 });
    expect(tracker.count('missing-parent')).toBe(0);
    expect(tracker.totalParents()).toBe(0);
  });

  it('removes a tracked delegation without completing remaining delegations', () => {
    const tracker = new PendingDelegationNotifications();

    tracker.track('parent-session', 'cancelled');
    tracker.track('parent-session', 'remaining');

    expect(tracker.remove('parent-session', 'cancelled')).toEqual({ allComplete: false, remaining: 1 });
    expect(tracker.complete('parent-session', 'remaining')).toEqual({ allComplete: true, remaining: 0 });
    expect(tracker.count('parent-session')).toBe(0);
    expect(tracker.totalParents()).toBe(0);
  });

  it('waits for completion notification delivery before dispatching all-complete notification', async () => {
    const client = createClient();
    const prompt = vi.mocked(client.session.prompt);
    const firstPrompt = createDeferred<PromptResult>();
    const promptResult = { data: {} } as PromptResult;
    const delegation = createDelegation({
      id: 'green-owl',
      parentSessionID: 'root-session',
      parentAgent: 'general',
    });

    prompt.mockReset();
    prompt.mockImplementationOnce(() => firstPrompt.promise as ReturnType<OpencodeClient['session']['prompt']>);
    prompt.mockResolvedValueOnce(promptResult);

    const dispatchPromise = dispatchDelegationNotifications(client, delegation, true);

    await Promise.resolve();

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt.mock.calls[0]?.[0]).toEqual({
      path: { id: 'root-session' },
      body: {
        noReply: true,
        agent: 'general',
        parts: [
          {
            type: 'text',
            text: `[TASK NOTIFICATION]
ID: green-owl
Status: complete
Use delegation_read(id) to retrieve the full result.`,
          },
        ],
      },
    });

    firstPrompt.resolve(promptResult);

    await dispatchPromise;

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(prompt.mock.calls.map(([input]) => input)).toEqual([
      prompt.mock.calls[0]?.[0],
      {
        path: { id: 'root-session' },
        body: {
          noReply: false,
          agent: 'general',
          parts: [{ type: 'text', text: '[TASK NOTIFICATION] All delegations complete.' }],
        },
      },
    ]);
  });

  it('dispatches only the completion notification when delegations remain pending', async () => {
    const client = createClient();
    const delegation = createDelegation({ id: 'red-panda' });

    await dispatchDelegationNotifications(client, delegation, false);

    expect(client.session.prompt).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.session.prompt).mock.calls[0]?.[0]).toEqual({
      path: { id: 'parent-session' },
      body: {
        noReply: true,
        agent: 'build',
        parts: [
          {
            type: 'text',
            text: `[TASK NOTIFICATION]
ID: red-panda
Status: complete
Use delegation_read(id) to retrieve the full result.`,
          },
        ],
      },
    });
  });
});
