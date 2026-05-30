import { describe, expect, it } from 'vitest';

import plugin from '../index.tsx';

describe('cache tui plugin', () => {
  it('exposes a stable plugin contract', () => {
    expect(plugin.id).toBe('cache');
    expect(typeof plugin.tui).toBe('function');
  });
});
