import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');

  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    readdirSync: vi.fn(actual.readdirSync),
    statSync: vi.fn(actual.statSync),
  };
});

import { readdirSync } from 'node:fs';

import { hydrateDoneChildTokens, readOpenCodeLogFileIfSmall } from '../src/infrastructure/logs.ts';

describe('logs', () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('reads small log files and hydrates token totals', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mrjmpl3-subagent-status-logs-'));
    tempDirs.push(dir);
    const logDir = join(dir, 'log');
    const logPath = join(logDir, '2026-06-04.log');

    await mkdir(logDir, { recursive: true });

    await writeFile(
      logPath,
      [
        '2026-06-04T00:00:00.000Z session=ses_1 {"tokens":{"input":12}}',
        '2026-06-04T00:00:01.000Z session=ses_1 {"tokens":{"output":8,"total":20}}',
      ].join('\n'),
      'utf8',
    );

    expect(readOpenCodeLogFileIfSmall(logPath)).toContain('session=ses_1');
    expect(hydrateDoneChildTokens('ses_1', logDir)).toEqual({
      input: 12,
      output: 8,
      total: 20,
    });
  });

  it('recovers token totals and context percent from nested usage payloads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mrjmpl3-subagent-status-logs-'));
    tempDirs.push(dir);
    const logDir = join(dir, 'log');
    const logPath = join(logDir, '2026-06-05.log');

    await mkdir(logDir, { recursive: true });

    await writeFile(
      logPath,
      '2026-06-05T00:00:00.000Z session=ses_nested {"usage":{"prompt_tokens":"1200","completion_tokens":300,"total_tokens":1500,"context_usage":0.423}}',
      'utf8',
    );

    expect(hydrateDoneChildTokens('ses_nested', logDir)).toEqual({
      input: 1200,
      output: 300,
      total: 1500,
      contextPercent: 42.3,
    });
  });

  it('falls through empty token payloads until a later recoverable usage line', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mrjmpl3-subagent-status-logs-'));
    tempDirs.push(dir);
    const logDir = join(dir, 'log');
    const logPath = join(logDir, '2026-06-06.log');

    await mkdir(logDir, { recursive: true });

    await writeFile(
      logPath,
      [
        '2026-06-06T00:00:00.000Z session=ses_fallthrough {"tokens":{}}',
        '2026-06-06T00:00:01.000Z session=ses_fallthrough {"result":{"usage":{"input_tokens":9,"output_tokens":4,"total_tokens":13,"context_percent":17}}}',
      ].join('\n'),
      'utf8',
    );

    expect(hydrateDoneChildTokens('ses_fallthrough', logDir)).toEqual({
      input: 9,
      output: 4,
      total: 13,
      contextPercent: 17,
    });
  });

  it('evicts old done token cache entries once the cap is exceeded', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mrjmpl3-subagent-status-logs-'));
    tempDirs.push(dir);
    const logDir = join(dir, 'log');
    const logPath = join(logDir, '2026-06-07.log');
    const mockedReaddirSync = vi.mocked(readdirSync);

    await mkdir(logDir, { recursive: true });

    await writeFile(
      logPath,
      Array.from({ length: 65 }, (_, index) => {
        const sessionID = `ses_cache_${String(index).padStart(3, '0')}`;
        return `2026-06-07T00:00:${String(index).padStart(2, '0')}.000Z session=${sessionID} {"tokens":{"total":${index + 1}}}`;
      }).join('\n'),
      'utf8',
    );

    for (let index = 0; index < 65; index += 1) {
      expect(hydrateDoneChildTokens(`ses_cache_${String(index).padStart(3, '0')}`, logDir)).toEqual({
        total: index + 1,
      });
    }

    expect(mockedReaddirSync).toHaveBeenCalledTimes(65);

    expect(hydrateDoneChildTokens('ses_cache_000', logDir)).toEqual({ total: 1 });
    expect(mockedReaddirSync).toHaveBeenCalledTimes(66);
  });
});
