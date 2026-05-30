import { beforeEach, describe, expect, it, vi } from 'vitest';

import RtkOpenCodePlugin from '../src/index.ts';

type ShellResult = {
  stdout: string;
};

type ShellRunner = {
  nothrow: () => Promise<ShellResult>;
  quiet: () => Promise<ShellResult> | ShellRunner;
};

type ToolExecuteBefore = NonNullable<Awaited<ReturnType<typeof RtkOpenCodePlugin>>['tool.execute.before']>;

const createShell = ({
  rewrite,
  whichFails = false,
}: {
  rewrite?: (command: string) => string;
  whichFails?: boolean;
}) => {
  const calls: string[] = [];

  const shell = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const command = strings.reduce((accumulator, part, index) => accumulator + part + (values[index] ?? ''), '');
    calls.push(command);

    if (command === 'which rtk') {
      return {
        quiet: async () => {
          if (whichFails) throw new Error('missing');

          return { stdout: 'rtk\n' };
        },
      };
    }

    if (command.startsWith('rtk rewrite ')) {
      const originalCommand = command.slice('rtk rewrite '.length);

      const runner: ShellRunner = {
        nothrow: async () => ({
          stdout: rewrite ? rewrite(originalCommand) : originalCommand,
        }),
        quiet: () => runner,
      };

      return runner;
    }

    throw new Error(`Unexpected command: ${command}`);
  }) as unknown as (strings: TemplateStringsArray, ...values: unknown[]) => ShellRunner;

  return { calls, shell };
};

const createHook = async ({ rewrite, whichFails }: { rewrite?: (command: string) => string; whichFails?: boolean }) => {
  const shellState = createShell({ rewrite, whichFails });
  const hooks = await RtkOpenCodePlugin({
    $: shellState.shell as never,
    client: {} as never,
    directory: '/tmp',
    experimental_workspace: {
      register: () => {},
    },
    project: {} as never,
    serverUrl: new URL('https://example.com'),
    worktree: '/tmp',
  });

  return {
    calls: shellState.calls,
    executeBefore: hooks['tool.execute.before'] as ToolExecuteBefore | undefined,
  };
};

describe('RtkOpenCodePlugin', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('disables itself when rtk is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { calls, executeBefore } = await createHook({ whichFails: true });

    expect(executeBefore).toBeUndefined();
    expect(calls).toEqual(['which rtk']);
    expect(warn).toHaveBeenCalledWith('[rtk] rtk binary not found in PATH — plugin disabled');
  });

  it('rewrites bash commands when rtk returns a different command', async () => {
    const { executeBefore } = await createHook({
      rewrite: () => 'rtk git status --short',
    });
    const args = { command: 'git status --short' };

    await executeBefore?.({ callID: 'call', sessionID: 'session', tool: 'bash' }, {
      args,
    } as never);

    expect(args.command).toBe('rtk git status --short');
  });

  it('ignores non-bash tools', async () => {
    const { calls, executeBefore } = await createHook({
      rewrite: () => 'changed',
    });
    const args = { command: 'git status --short' };

    await executeBefore?.({ callID: 'call', sessionID: 'session', tool: 'read' }, {
      args,
    } as never);

    expect(args.command).toBe('git status --short');
    expect(calls).toEqual(['which rtk']);
  });

  it('keeps the original command when rewrite output is empty', async () => {
    const { executeBefore } = await createHook({ rewrite: () => '' });
    const args = { command: 'git status --short' };

    await executeBefore?.({ callID: 'call', sessionID: 'session', tool: 'bash' }, {
      args,
    } as never);

    expect(args.command).toBe('git status --short');
  });

  it('keeps the original command when rewrite fails', async () => {
    const { executeBefore } = await createHook({
      rewrite: () => {
        throw new Error('fail');
      },
    });
    const args = { command: 'git status --short' };

    await executeBefore?.({ callID: 'call', sessionID: 'session', tool: 'bash' }, {
      args,
    } as never);

    expect(args.command).toBe('git status --short');
  });
});
