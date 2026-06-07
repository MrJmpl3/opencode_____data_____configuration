import { describe, expect, it, vi } from 'vitest';

import { registerSubagentCommands } from '../src/runtime/commands.ts';

describe('runtime commands', () => {
  it('registers command-palette commands without keybindings and disposes them', () => {
    const keymapDispose = vi.fn();
    const commandDispose = vi.fn();
    const registerLayer = vi.fn<(layer: { commands: Array<{ run: () => void }> }) => () => void>(() => keymapDispose);
    const register = vi.fn<(commands: () => Array<{ onSelect?: () => void }>) => () => void>(() => commandDispose);
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

    const keymapLayer = registerLayer.mock.calls[0]?.[0] as { commands: Array<{ run: () => void }> } | undefined;
    expect(keymapLayer).toBeDefined();
    if (!keymapLayer) throw new Error('Expected keymap layer registration');

    expect(keymapLayer.commands).toHaveLength(2);
    expect(keymapLayer).not.toHaveProperty('bindings');

    const legacyCommandFactory = register.mock.calls[0]?.[0] as (() => Array<{ onSelect?: () => void }>) | undefined;
    expect(legacyCommandFactory).toBeDefined();
    if (!legacyCommandFactory) throw new Error('Expected legacy command registration');

    const legacyCommands = legacyCommandFactory();
    expect(legacyCommands).toHaveLength(2);

    keymapLayer.commands[0].run();
    keymapLayer.commands[1].run();
    legacyCommands[0]?.onSelect?.();
    legacyCommands[1]?.onSelect?.();
    expect(setSectionEnabled).toHaveBeenNthCalledWith(1, true);
    expect(setSectionEnabled).toHaveBeenNthCalledWith(2, true);
    expect(setSectionEnabled).toHaveBeenNthCalledWith(3, false);
    expect(setSectionEnabled).toHaveBeenNthCalledWith(4, true);

    dispose();

    expect(keymapDispose).toHaveBeenCalledTimes(1);
    expect(commandDispose).toHaveBeenCalledTimes(1);
  });
});
