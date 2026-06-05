import { describe, expect, it, vi } from 'vitest';

import { registerSubagentCommands } from '../src/runtime/commands.ts';

describe('runtime commands', () => {
  it('registers keymap and legacy commands and disposes them', () => {
    const keymapDispose = vi.fn();
    const commandDispose = vi.fn();
    const registerLayer = vi.fn<(layer: { commands: Array<{ run: () => void }>; bindings?: unknown[] }) => () => void>(() => keymapDispose);
    const register = vi.fn(() => commandDispose);
    const setSectionEnabled = vi.fn();
    let enabled = false;

    const dispose = registerSubagentCommands({
      api: {
        keymap: { registerLayer },
        command: { register },
      },
      sectionEnabled: () => enabled,
      setSectionEnabled: (value) => {
        enabled = value;
        setSectionEnabled(value);
      },
    });

    expect(registerLayer).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledTimes(1);

    const keymapLayer = registerLayer.mock.calls[0]?.[0] as { commands: Array<{ run: () => void }>; bindings?: unknown[] } | undefined;
    expect(keymapLayer).toBeDefined();
    if (!keymapLayer) throw new Error('Expected keymap layer registration');

    expect(keymapLayer.commands).toHaveLength(2);
    expect(keymapLayer.bindings).toEqual([{ key: 'alt+b', cmd: 'subagent-statusline.show-sidebar-section' }]);

    keymapLayer.commands[0].run();
    keymapLayer.commands[1].run();
    expect(setSectionEnabled).toHaveBeenNthCalledWith(1, true);
    expect(setSectionEnabled).toHaveBeenNthCalledWith(2, true);

    dispose();

    expect(keymapDispose).toHaveBeenCalledTimes(1);
    expect(commandDispose).toHaveBeenCalledTimes(1);
  });
});
