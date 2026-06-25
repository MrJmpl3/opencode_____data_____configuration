import type { TuiPluginApi, TuiPluginMeta } from '@opencode-ai/plugin/tui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import plugin from '../index.tsx';
import { summarizeCacheMessages } from '../src/domain/summary.ts';
import { slotSessionId } from '@mrjmpl3/tui-kit';

const pluginMeta: TuiPluginMeta = {
  id: 'cache',
  source: 'file',
  spec: 'cache',
  target: 'cache',
  first_time: 0,
  last_time: 0,
  time_changed: 0,
  load_count: 1,
  fingerprint: 'test',
  state: 'first',
};

describe('cache tui plugin', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('exposes a stable plugin contract', () => {
    expect(plugin.id).toBe('cache');
    expect(typeof plugin.tui).toBe('function');
  });

  it('detects write-only cache data from message tokens', () => {
    const summary = summarizeCacheMessages([
      {
        id: 'assistant-1',
        role: 'assistant',
        tokens: {
          input: 120,
          output: 30,
          cache: { write: 45 },
        },
      },
    ]);

    expect(summary.hasData).toBe(true);
    expect(summary.hasWriteData).toBe(true);
    expect(summary.read).toBe(0);
    expect(summary.write).toBe(45);
    expect(summary.ratio).toBe(0);
  });

  it('detects part-level cache writes when message cache reads are absent', () => {
    const summary = summarizeCacheMessages(
      [
        {
          id: 'assistant-1',
          role: 'assistant',
          tokens: {
            input: 100,
            output: 20,
          },
        },
      ],
      (messageId) =>
        messageId === 'assistant-1'
          ? [
              {
                tokens: {
                  cache: { write: 25 },
                },
              },
            ]
          : [],
    );

    expect(summary.hasData).toBe(true);
    expect(summary.hasWriteData).toBe(true);
    expect(summary.write).toBe(25);
  });

  it('extracts slot session ids defensively', () => {
    expect(slotSessionId({ session_id: 'session-1' })).toBe('session-1');
    expect(slotSessionId(null, 'fallback')).toBe('fallback');
    expect(slotSessionId({ session_id: 123 }, 'fallback')).toBe('fallback');
  });

  it('registers a sidebar slot, refreshes from the active session, and disposes event handlers', async () => {
    const events = new Map<string, (event: unknown) => void>();
    const disposers: (() => void)[] = [];
    const slotRegistrations: { slots: { sidebar_content: (ctx: unknown, slotInput: unknown) => unknown } }[] = [];
    const messages = vi.fn(() => [
      {
        id: 'assistant-1',
        role: 'assistant',
        tokens: { input: 100, output: 25, cache: { read: 50 } },
      },
    ]);

    const api = {
      event: {
        on: (eventName: string, handler: (event: unknown) => void) => {
          events.set(eventName, handler);
          return () => events.delete(eventName);
        },
      },
      lifecycle: {
        onDispose: (handler: () => void) => disposers.push(handler),
      },
      slots: {
        register: (registration: { slots: { sidebar_content: (ctx: unknown, slotInput: unknown) => unknown } }) => {
          slotRegistrations.push(registration);
        },
      },
      state: {
        part: () => [],
        session: { messages },
      },
      theme: { current: { text: 'white', textMuted: 'gray' } },
    } as unknown as TuiPluginApi;

    await plugin.tui(api, undefined, pluginMeta);

    expect(slotRegistrations).toHaveLength(1);
    events.get('session.idle')?.({ properties: { sessionID: 'session-1' } });
    expect(messages).toHaveBeenLastCalledWith('session-1');

    disposers.forEach((dispose) => dispose());
    expect(events.size).toBe(0);
  });
});
