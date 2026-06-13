import { writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

import type { ModelVariants } from './types.ts';

/**
 * ENOENT races (another process removed the file first) are harmless
 * and should not be surfaced as errors.
 */
function isIgnorableFileRace(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === 'ENOENT'
  );
}

async function removeOwnTempFile(tmpPath: string): Promise<void> {
  try {
    await rm(tmpPath, { force: true });
  } catch (err) {
    if (!isIgnorableFileRace(err)) {
      console.error('[model-variants] temp cleanup failed:', err);
    }
  }
}

export function getVariantsCachePath(homeDirectory = homedir()): string {
  return path.join(homeDirectory, '.gentle-ai', 'cache', 'model-variants.json');
}

/**
 * Atomically writes the variant cache.
 *
 * Uses a per-invocation random temp name (issues #766, #786):
 * 1. Write JSON to a unique tmp file so concurrent plugin loads never collide.
 * 2. rename() the tmp to final path (atomic on POSIX).
 * 3. On failure, clean up the tmp file so stale artifacts don't accumulate.
 */
export async function writeVariantsCache(variants: ModelVariants, finalPath = getVariantsCachePath()): Promise<void> {
  await mkdir(path.dirname(finalPath), { recursive: true });

  const dir = path.dirname(finalPath);
  const base = path.basename(finalPath);
  const tmpPath = path.join(dir, `${base}.${randomBytes(3).toString('hex')}.tmp`);

  try {
    await writeFile(tmpPath, JSON.stringify(variants, null, 2));
    await rename(tmpPath, finalPath);
  } catch (err) {
    // Best-effort cleanup — don't mask the original error.
    await removeOwnTempFile(tmpPath);
    throw err;
  }
}
