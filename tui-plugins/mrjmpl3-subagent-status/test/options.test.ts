import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DONE_RETENTION_MS,
  DEFAULT_STALE_RETENTION_MS,
  DEFAULT_STALE_RUNNING_PROBE_POLICY,
  resolveSubagentStatusPluginOptions,
} from '../src/runtime/options.ts';

describe('subagent status options', () => {
  it('returns defaults when plugin options are omitted', () => {
    expect(resolveSubagentStatusPluginOptions(undefined)).toEqual({
      staleRunningProbePolicy: DEFAULT_STALE_RUNNING_PROBE_POLICY,
      visibility: {
        doneRetentionMs: DEFAULT_DONE_RETENTION_MS,
        staleRetentionMs: DEFAULT_STALE_RETENTION_MS,
      },
      persistence: {
        statePath: undefined,
        preserveStateOnStartup: false,
      },
      recovery: {
        sqliteDatabasePath: undefined,
      },
    });
  });

  it('normalizes explicit plugin options without relying on environment variables', () => {
    expect(
      resolveSubagentStatusPluginOptions({
        staleRunningProbePolicy: {
          baseBackoffMs: 500,
          hardStaleAfterMs: -1,
          maxBackoffMs: 200,
          maxAttempts: -3,
          refreshIntervalMs: 0,
        },
        visibility: {
          doneRetentionMs: -5,
          staleRetentionMs: -1,
        },
        persistence: {
          statePath: ' /tmp/subagent-status.json ',
          preserveStateOnStartup: true,
        },
        recovery: {
          sqliteDatabasePath: '/tmp/opencode.db',
        },
      }),
    ).toEqual({
      staleRunningProbePolicy: {
        baseBackoffMs: 1_000,
        hardStaleAfterMs: 0,
        maxBackoffMs: 1_000,
        maxAttempts: 0,
        refreshIntervalMs: 1_000,
      },
      visibility: {
        doneRetentionMs: 0,
        staleRetentionMs: 0,
      },
      persistence: {
        statePath: '/tmp/subagent-status.json',
        preserveStateOnStartup: true,
      },
      recovery: {
        sqliteDatabasePath: '/tmp/opencode.db',
      },
    });
  });

  it('accepts legacy stale retention overrides for persisted stale rows', () => {
    expect(
      resolveSubagentStatusPluginOptions({
        visibility: {
          staleRetentionMs: 30 * 60_000 + 900,
        },
      }),
    ).toMatchObject({
      visibility: {
        doneRetentionMs: DEFAULT_DONE_RETENTION_MS,
        staleRetentionMs: 1_800_900,
      },
    });
  });

  it('accepts explicit done retention overrides for completed row visibility', () => {
    expect(
      resolveSubagentStatusPluginOptions({
        visibility: {
          doneRetentionMs: 15 * 60_000 + 450,
        },
      }),
    ).toMatchObject({
      visibility: {
        doneRetentionMs: 900_450,
        staleRetentionMs: DEFAULT_STALE_RETENTION_MS,
      },
    });
  });

  it('accepts explicit hard stale safety-net overrides', () => {
    expect(
      resolveSubagentStatusPluginOptions({
        staleRunningProbePolicy: {
          hardStaleAfterMs: 90 * 60_000,
        },
      }),
    ).toMatchObject({
      staleRunningProbePolicy: {
        hardStaleAfterMs: 5_400_000,
      },
    });
  });
});
