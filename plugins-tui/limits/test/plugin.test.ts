import { describe, expect, it } from 'vitest';

import plugin from '../index.tsx';

describe('limits tui plugin', () => {
  it('exposes a stable plugin contract', () => {
    expect(plugin.id).toBe('limits');
    expect(typeof plugin.tui).toBe('function');
  });
});
