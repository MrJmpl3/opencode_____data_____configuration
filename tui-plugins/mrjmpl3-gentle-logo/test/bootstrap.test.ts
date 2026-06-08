import type { TuiPluginApi } from '@opencode-ai/plugin/tui';
import { describe, expect, it, vi } from 'vitest';

describe('plugin bootstrap', () => {
  it('exports the Gentle logo plugin module', async () => {
    vi.doMock('@opentui/solid/jsx-runtime', () => ({
      Fragment: 'fragment',
      jsx: () => ({}),
      jsxs: () => ({}),
    }));
    vi.doMock('../src/ui/Logo.tsx', () => ({
      Logo: () => ({}),
    }));

    const { default: plugin } = await import('../index.tsx');

    expect(plugin.id).toBe('mrjmpl3-gentle-logo');
    expect(plugin.tui).toBeTypeOf('function');
  });

  it('registers the home logo slot', async () => {
    vi.doMock('@opentui/solid/jsx-runtime', () => ({
      Fragment: 'fragment',
      jsx: () => ({}),
      jsxs: () => ({}),
    }));
    vi.doMock('../src/ui/Logo.tsx', () => ({
      Logo: () => ({}),
    }));

    const { default: plugin, GENTLE_LOGO_SLOT_ORDER } = await import('../index.tsx');

    const register = vi.fn();
    const api = {
      slots: {
        register,
      },
    } as unknown as TuiPluginApi;

    await plugin.tui(api, undefined, undefined as never);

    expect(register).toHaveBeenCalledOnce();
    expect(register).toHaveBeenCalledWith({
      order: GENTLE_LOGO_SLOT_ORDER,
      slots: {
        home_logo: expect.any(Function),
      },
    });
  });
});
