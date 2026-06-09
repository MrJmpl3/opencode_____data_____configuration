import { execFile as execFileCallback } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TimeoutError, getProjectId, withTimeout } from '../index.ts';

const execFile = promisify(execFileCallback);

describe('withTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects zero timeouts immediately', async () => {
    await expect(withTimeout(Promise.resolve('done'), 0, 'too slow')).rejects.toBeInstanceOf(TimeoutError);
  });

  it('rejects invalid timeout values before waiting', async () => {
    await expect(withTimeout(Promise.resolve('done'), Number.NaN)).rejects.toThrow(
      'withTimeout: timeout must be a non-negative number',
    );
  });

  it('rejects with TimeoutError when the operation never resolves', async () => {
    const result = withTimeout(new Promise(() => {}), 50, 'operation timed out');
    const expectation = expect(result).rejects.toMatchObject({ name: 'TimeoutError', timeoutMs: 50 });

    await vi.advanceTimersByTimeAsync(50);

    await expectation;
  });
});

describe('getProjectId', () => {
  let projectDir: string;

  async function runGit(args: string[], cwd: string): Promise<string> {
    const { stdout } = await execFile(
      'git',
      [
        '-c',
        'user.name=Test User',
        '-c',
        'user.email=test@example.com',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'init.defaultObjectFormat=sha1',
        ...args,
      ],
      {
        cwd,
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: '2024-01-01T00:00:00Z',
          GIT_COMMITTER_DATE: '2024-01-01T00:00:00Z',
        },
      },
    );

    return stdout;
  }

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'background-agents-project-'));
  });

  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('rejects empty project roots', async () => {
    await expect(getProjectId('')).rejects.toThrow('projectRoot is required');
  });

  it('falls back to a stable hash when the directory is not a git repository', async () => {
    const first = await getProjectId(projectDir);
    const second = await getProjectId(projectDir);

    expect(first).toMatch(/^[a-f0-9]{16}$/);
    expect(second).toBe(first);
  });

  it('uses the root commit for a normal git repository and caches it in .git/opencode', async () => {
    await runGit(['init'], projectDir);
    await fs.writeFile(path.join(projectDir, 'README.md'), 'Test project\n', 'utf8');
    await runGit(['add', 'README.md'], projectDir);
    await runGit(['commit', '-m', 'Initial commit'], projectDir);
    const expected = (await runGit(['rev-list', '--max-parents=0', '--all'], projectDir)).trim();

    const projectId = await getProjectId(projectDir);
    const cached = await fs.readFile(path.join(projectDir, '.git', 'opencode'), 'utf8');

    expect(projectId).toBe(expected);
    expect(cached.trim()).toBe(expected);
  });

  it('uses a cached .git/opencode project ID without shelling out to git', async () => {
    const cachedProjectId = '1234567890abcdef';
    await fs.mkdir(path.join(projectDir, '.git'));
    await fs.writeFile(path.join(projectDir, '.git', 'opencode'), cachedProjectId, 'utf8');

    await expect(getProjectId(projectDir)).resolves.toBe(cachedProjectId);
  });

  it('resolves a worktree .git file through commondir before reading cached project ID', async () => {
    const cachedProjectId = 'abcdef1234567890';
    const mainGitDir = path.join(projectDir, 'main', '.git');
    const worktreeDir = path.join(projectDir, 'worktree');
    const worktreeGitDir = path.join(mainGitDir, 'worktrees', 'worktree');
    await fs.mkdir(worktreeGitDir, { recursive: true });
    await fs.mkdir(worktreeDir);
    await fs.writeFile(path.join(worktreeDir, '.git'), `gitdir: ${worktreeGitDir}\n`, 'utf8');
    await fs.writeFile(path.join(worktreeGitDir, 'commondir'), '../..\n', 'utf8');
    await fs.writeFile(path.join(mainGitDir, 'opencode'), cachedProjectId, 'utf8');

    await expect(getProjectId(worktreeDir)).resolves.toBe(cachedProjectId);
  });

  it('fails loudly for malformed gitdir files', async () => {
    await fs.writeFile(path.join(projectDir, '.git'), 'not a gitdir pointer', 'utf8');

    await expect(getProjectId(projectDir)).rejects.toThrow('.git file exists but has invalid format');
  });
});
