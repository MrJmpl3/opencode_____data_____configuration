import { isPlainObject as isRecord } from '@mrjmpl3/tui-kit';
import {
  DEFAULT_DONE_RETENTION_MS,
  DEFAULT_STALE_RETENTION_MS,
  DEFAULT_SUBAGENT_VISIBILITY_POLICY,
  type SubagentVisibilityPolicy,
} from '../shared/visibility.ts';

export type StaleRunningProbePolicy = {
  baseBackoffMs: number;
  hardStaleAfterMs: number;
  maxBackoffMs: number;
  maxAttempts: number;
  refreshIntervalMs: number;
};

export interface SubagentStatusStaleRunningProbePolicyOptions {
  /**
   * Base backoff for probing a session that still appears as running. Invalid
   * values are replaced by the safe minimum.
   */
  baseBackoffMs?: number;
  hardStaleAfterMs?: number;
  /**
   * Exponential backoff ceiling so abandoned probes do not run forever while
   * still avoiding excessive pressure on sessions that have not emitted
   * terminal evidence yet.
   */
  maxBackoffMs?: number;
  /**
   * Maximum extra probes before waiting for new visible session activity.
   */
  maxAttempts?: number;
  /**
   * Reconciliation loop interval used to decide whether running-session probes
   * should run.
   */
  refreshIntervalMs?: number;
}

export interface SubagentStatusPersistenceOptions {
  /**
   * Explicit persisted snapshot path. This lets `tui.json` choose the file
   * instead of relying on external conventions or environment variables.
   */
  statePath?: string;
  /**
   * When true, the runtime attempts to load the last snapshot on startup.
   * When false or omitted, it starts from an empty state.
   */
  preserveStateOnStartup?: boolean;
}

export interface SubagentStatusRecoveryOptions {
  /**
   * Explicit OpenCode SQLite database path used for recovery. The plugin does
   * not read plugin-specific configuration from environment variables; this
   * `options` object is the supported input boundary.
   */
  sqliteDatabasePath?: string;
}

export interface SubagentStatusVisibilityOptions {
  doneRetentionMs?: number;
  /**
   * How long a legacy `stale` child remains eligible for visibility. Current
   * abandoned-session detection marks rows as `error` instead.
   */
  staleRetentionMs?: number;
}

/**
 * Public shape of the `options` object that accompanies this plugin in
 * `tui.json`.
 *
 * Ejemplo de la entrada completa:
 * `[
 *   "/abs/path/to/mrjmpl3-subagent-status",
 *   {
 *     staleRunningProbePolicy: { refreshIntervalMs: 120000 },
 *     visibility: { staleRetentionMs: 1800000 },
 *     persistence: { statePath: "/tmp/subagent-status.json" },
 *     recovery: { sqliteDatabasePath: "/tmp/opencode.db" }
 *   }
 * ]`
 *
 * OpenCode passes that second tuple element as `options: unknown`, so this
 * module defines the expected shape and normalizes it at a single boundary.
 * Environment variables are not a supported plugin-specific configuration
 * path.
 */
export interface SubagentStatusPluginOptions {
  staleRunningProbePolicy?: SubagentStatusStaleRunningProbePolicyOptions;
  visibility?: SubagentStatusVisibilityOptions;
  persistence?: SubagentStatusPersistenceOptions;
  recovery?: SubagentStatusRecoveryOptions;
  debug?: boolean;
}

/**
 * Helper alias for typing a complete `plugin` array entry in `tui.json`: the
 * first element is the plugin spec/path, and the second is the options object
 * normalized by this module.
 */
export type SubagentStatusPluginConfigEntry = readonly [pluginSpec: string, options: SubagentStatusPluginOptions];

export interface ResolvedSubagentStatusPluginOptions {
  staleRunningProbePolicy: StaleRunningProbePolicy;
  visibility: SubagentVisibilityPolicy;
  persistence: {
    statePath?: string;
    preserveStateOnStartup: boolean;
  };
  recovery: {
    sqliteDatabasePath?: string;
  };
  debug: boolean;
}

export const DEFAULT_STALE_RUNNING_PROBE_POLICY: StaleRunningProbePolicy = {
  baseBackoffMs: 60_000,
  hardStaleAfterMs: 5 * 60 * 60_000,
  maxBackoffMs: 5 * 60_000,
  maxAttempts: 4,
  refreshIntervalMs: 60_000,
};

export { DEFAULT_DONE_RETENTION_MS, DEFAULT_STALE_RETENTION_MS };

const MIN_BACKOFF_MS = 1_000;
const MIN_REFRESH_INTERVAL_MS = 1_000;
const MAX_MAX_ATTEMPTS = 100;

const stringOption = (value: unknown): string | undefined => {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
};

const numberOption = (value: unknown): number | undefined => {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

const integerOption = (value: unknown): number | undefined => {
  const parsed = numberOption(value);
  return parsed === undefined ? undefined : Math.floor(parsed);
};

/**
 * Normalizes the raw payload received from `plugin: [[spec, options]]`.
 * Keeping this conversion in one place prevents the runtime from guessing at
 * partial shapes or reintroducing environment-variable configuration.
 */
export const normalizeSubagentStatusPluginOptions = (options: unknown): ResolvedSubagentStatusPluginOptions => {
  const pluginOptions = isRecord(options) ? options : {};
  const staleRunningProbePolicy = isRecord(pluginOptions.staleRunningProbePolicy)
    ? pluginOptions.staleRunningProbePolicy
    : {};
  const visibility = isRecord(pluginOptions.visibility) ? pluginOptions.visibility : {};
  const persistence = isRecord(pluginOptions.persistence) ? pluginOptions.persistence : {};
  const recovery = isRecord(pluginOptions.recovery) ? pluginOptions.recovery : {};

  const baseBackoffMs = Math.max(
    MIN_BACKOFF_MS,
    numberOption(staleRunningProbePolicy.baseBackoffMs) ?? DEFAULT_STALE_RUNNING_PROBE_POLICY.baseBackoffMs,
  );
  const maxBackoffMs = Math.max(
    baseBackoffMs,
    numberOption(staleRunningProbePolicy.maxBackoffMs) ?? DEFAULT_STALE_RUNNING_PROBE_POLICY.maxBackoffMs,
  );
  const maxAttempts = Math.min(
    MAX_MAX_ATTEMPTS,
    Math.max(0, integerOption(staleRunningProbePolicy.maxAttempts) ?? DEFAULT_STALE_RUNNING_PROBE_POLICY.maxAttempts),
  );
  const hardStaleAfterMs = Math.max(
    0,
    integerOption(staleRunningProbePolicy.hardStaleAfterMs) ?? DEFAULT_STALE_RUNNING_PROBE_POLICY.hardStaleAfterMs,
  );
  const refreshIntervalMs = Math.max(
    MIN_REFRESH_INTERVAL_MS,
    numberOption(staleRunningProbePolicy.refreshIntervalMs) ?? DEFAULT_STALE_RUNNING_PROBE_POLICY.refreshIntervalMs,
  );
  const staleRetentionMs = Math.max(0, integerOption(visibility.staleRetentionMs) ?? DEFAULT_STALE_RETENTION_MS);
  const doneRetentionMs = Math.max(0, integerOption(visibility.doneRetentionMs) ?? DEFAULT_DONE_RETENTION_MS);

  return {
    staleRunningProbePolicy: {
      baseBackoffMs,
      hardStaleAfterMs,
      maxBackoffMs,
      maxAttempts,
      refreshIntervalMs,
    },
    visibility: {
      ...DEFAULT_SUBAGENT_VISIBILITY_POLICY,
      doneRetentionMs,
      staleRetentionMs,
    },
    persistence: {
      statePath: stringOption(persistence.statePath),
      preserveStateOnStartup: persistence.preserveStateOnStartup === true,
    },
    recovery: {
      sqliteDatabasePath: stringOption(recovery.sqliteDatabasePath),
    },
    debug: pluginOptions.debug === true,
  };
};

export const resolveSubagentStatusPluginOptions = normalizeSubagentStatusPluginOptions;
