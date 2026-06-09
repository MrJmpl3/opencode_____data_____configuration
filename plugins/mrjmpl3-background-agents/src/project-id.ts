import * as crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, readFile, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import type { OpencodeClient } from './types.ts';

export function logWarn(client: OpencodeClient | undefined, service: string, message: string): void {
  if (!client) {
    console.warn(`[${service}] ${message}`);

    return;
  }

  client.app.log({ body: { service, level: 'warn', message } }).catch(() => {});
}

function hashPath(projectRoot: string): string {
  const hash = crypto.createHash('sha256').update(projectRoot).digest('hex');

  return hash.slice(0, 16);
}

export async function getProjectId(projectRoot: string): Promise<string> {
  if (!projectRoot || typeof projectRoot !== 'string') {
    throw new Error('getProjectId: projectRoot is required and must be a string');
  }

  const gitPath = path.join(projectRoot, '.git');
  const gitStat = await stat(gitPath).catch(() => null);
  if (!gitStat) {
    return hashPath(projectRoot);
  }

  let gitDir = gitPath;
  if (gitStat.isFile()) {
    const content = await readFile(gitPath, 'utf8');
    const match = content.match(/^gitdir:\s*(.+)$/m);
    if (!match) {
      throw new Error(`getProjectId: .git file exists but has invalid format at ${gitPath}`);
    }

    const gitdirPath = match[1].trim();
    const resolvedGitdir = path.resolve(projectRoot, gitdirPath);
    const commondirPath = path.join(resolvedGitdir, 'commondir');

    if (
      await access(commondirPath)
        .then(() => true)
        .catch(() => false)
    ) {
      const commondirContent = (await readFile(commondirPath, 'utf8')).trim();
      gitDir = path.resolve(resolvedGitdir, commondirContent);
    } else {
      gitDir = path.resolve(resolvedGitdir, '../..');
    }

    const gitDirStat = await stat(gitDir).catch(() => null);
    if (!gitDirStat?.isDirectory()) {
      throw new Error(`getProjectId: Resolved gitdir ${gitDir} is not a directory`);
    }
  }

  const cacheFile = path.join(gitDir, 'opencode');
  if (
    await access(cacheFile)
      .then(() => true)
      .catch(() => false)
  ) {
    const cached = (await readFile(cacheFile, 'utf8')).trim();
    if (/^[a-f0-9]{40}$/i.test(cached) || /^[a-f0-9]{16}$/i.test(cached)) {
      return cached;
    }
  }

  try {
    const output = await new Promise<string>((resolve, reject) => {
      const proc = execFile(
        'git',
        ['rev-list', '--max-parents=0', '--all'],
        {
          cwd: projectRoot,
          timeout: 5000,
          env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined },
        },
        (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }

          resolve(stdout);
        },
      );

      proc.on('error', reject);
    });

    const roots = output
      .split('\n')
      .filter(Boolean)
      .map((root) => root.trim())
      .sort();

    if (roots.length > 0 && /^[a-f0-9]{40}$/i.test(roots[0])) {
      const projectId = roots[0];
      try {
        await writeFile(cacheFile, projectId, 'utf8');
      } catch {}

      return projectId;
    }
  } catch {}

  return hashPath(projectRoot);
}
