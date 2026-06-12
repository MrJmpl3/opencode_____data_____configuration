import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.fn();

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

describe('mrjmpl3-skill-registry plugin', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('refreshes the skill registry once from the system transform hook', async () => {
    execFileMock.mockImplementation(
      (_file: string, _args: string[], _options: { timeout: number }, callback: (error: Error | null) => void) => {
        callback(null);
      },
    );

    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { SkillRegistryPlugin } = await import('../index.ts');
    const plugin = await SkillRegistryPlugin({ directory: '/tmp/project' } as never);

    await plugin['experimental.chat.system.transform']?.({} as never, { system: [] } as never);
    await plugin['experimental.chat.system.transform']?.({} as never, { system: [] } as never);

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledWith(
      'gentle-ai',
      ['skill-registry', 'refresh', '--quiet', '--no-gitignore', '--cwd', '/tmp/project'],
      { timeout: 10_000 },
      expect.any(Function),
    );
    expect(info).toHaveBeenCalledWith('[mrjmpl3-skill-registry] skill-registry refresh completed');

    info.mockRestore();
  });

  it('logs a warning when the refresh command fails', async () => {
    execFileMock.mockImplementation(
      (_file: string, _args: string[], _options: { timeout: number }, callback: (error: Error | null) => void) => {
        callback(new Error('spawn gentle-ai ENOENT'));
      },
    );

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { refreshSkillRegistry } = await import('../index.ts');

    await refreshSkillRegistry('/tmp/project', (level, message) => {
      if (level === 'warn') {
        console.warn(`[mrjmpl3-skill-registry] ${message}`);
      }
    });

    expect(warn).toHaveBeenCalledWith(
      '[mrjmpl3-skill-registry] skill-registry refresh skipped: spawn gentle-ai ENOENT',
    );

    warn.mockRestore();
  });
});
