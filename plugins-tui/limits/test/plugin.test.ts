import { describe, expect, it } from 'vitest';

import plugin, { getModelFromMessages, resolveModel } from '../index.tsx';
import { slotSessionId } from '../../shared/tui.ts';

describe('limits tui plugin', () => {
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
});
