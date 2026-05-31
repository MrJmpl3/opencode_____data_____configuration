import { describe, expect, it } from 'vitest';

import plugin, { summarizeCacheMessages } from '../index.tsx';
import { slotSessionId } from '../../shared/tui.ts';

describe('cache tui plugin', () => {
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
});
