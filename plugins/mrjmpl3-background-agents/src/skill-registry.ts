import { execFile } from 'node:child_process';

export async function refreshSkillRegistry(
  directory: string,
  log: (level: 'info' | 'warn' | 'error', message: string) => void,
): Promise<void> {
  await new Promise<void>((resolve) => {
    execFile(
      'gentle-ai',
      ['skill-registry', 'refresh', '--quiet', '--no-gitignore', '--cwd', directory],
      { timeout: 10_000 },
      (error) => {
        if (error) {
          log('warn', `skill-registry refresh skipped: ${error.message}`);
        } else {
          log('info', 'skill-registry refresh completed');
        }
        resolve();
      },
    );
  });
}
