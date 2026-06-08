import type { TuiPluginApi, TuiPluginMeta } from '@opencode-ai/plugin/tui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import plugin from '../index.tsx';
import { getModelFromMessages, resolveModel } from '../src/domain/model.ts';
import { slotSessionId } from '../src/runtime/tui.ts';

const pluginMeta: TuiPluginMeta = {
  id: 'limits',
  source: 'file',
  spec: 'limits',
  target: 'limits',
  first_time: 0,
  last_time: 0,
  time_changed: 0,
  load_count: 1,
  fingerprint: 'test',
  state: 'first',
};

describe('limits tui plugin', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('exposes a stable plugin contract', () => {
    expect(plugin.id).toBe('limits');
    expect(typeof plugin.tui).toBe('function');
  });

  it('resolves missing model limits to zero instead of carrying stale values', () => {
    const providers = [
      {
        id: 'openai',
        models: {
          known: {
            name: 'Known',
            limit: { context: 128_000, output: 16_000 },
          },
          fallback: {
            name: 'Fallback',
          },
        },
      },
    ];

    expect(resolveModel('openai', 'known', providers)).toEqual({
      name: 'Known',
      context: 128_000,
      output: 16_000,
    });
    expect(resolveModel('openai', 'fallback', providers)).toEqual({
      name: 'Fallback',
      context: 0,
      output: 0,
    });
  });

  it('extracts the latest model even when provider metadata is unavailable', () => {
    expect(
      getModelFromMessages([
        { role: 'assistant', modelID: 'older', providerID: 'openai' },
        { role: 'user', model: { modelID: 'newer' } },
      ]),
    ).toEqual({ modelId: 'newer', providerId: undefined });
  });

  it('shares defensive slot session id extraction with other tui plugins', () => {
    expect(slotSessionId({ session_id: 'limits-session' })).toBe('limits-session');
    expect(slotSessionId(undefined)).toBe('');
  });

  it('registers a sidebar slot, refreshes from session messages, and ignores model switches without a session id', async () => {
    const events = new Map<string, (event: unknown) => void>();
    const disposers: (() => void)[] = [];
    const slotRegistrations: { slots: { sidebar_content: (ctx: unknown, slotInput: unknown) => unknown } }[] = [];
    const messages = vi.fn(() => [{ role: 'assistant', modelID: 'gpt-5', providerID: 'openai' }]);

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
        config: { model: '' },
        provider: [
          { id: 'openai', models: { 'gpt-5': { name: 'GPT-5', limit: { context: 400_000, output: 128_000 } } } },
        ],
        session: { messages },
      },
      theme: { current: { text: 'white', textMuted: 'gray' } },
    } as unknown as TuiPluginApi;

    await plugin.tui(api, undefined, pluginMeta);

    expect(slotRegistrations).toHaveLength(1);
    events.get('session.idle')?.({ properties: { sessionID: 'session-1' } });
    expect(messages).toHaveBeenLastCalledWith('session-1');

    events.get('session.next.model.switched')?.({ properties: { model: { id: 'gpt-4', providerID: 'openai' } } });
    expect(messages).toHaveBeenCalledTimes(1);

    disposers.forEach((dispose) => dispose());
    expect(events.size).toBe(0);
  });
});
