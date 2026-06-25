import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

import type { SubagentChild, SubagentState, SubagentTokens } from '../../domain/types.ts';
import { mergeSubagentTokens, normalizeSubagentTokens } from '../../domain/tokens.ts';
import { deriveTerminalSessionStatus } from '../../domain/session-status.ts';
import { debugLog } from '../../shared/debug.ts';
import { asString, isPlainObject as isRecord, normalizedString, timestampFromUnknown, toFiniteNumber } from '@mrjmpl3/tui-kit';
import { DEFAULT_STALE_RUNNING_PROBE_POLICY } from '../../runtime/options.ts';

import { applyRecoveredChildren } from '../recovery.ts';
import type { RecoveryContext, RecoveryResult, RecoverySource } from '../recovery.ts';

export type SQLiteRecoveryRow = {
  id: string;
  parentID: string;
  title: string;
  agentName?: string;
  startedAtMs: number;
  updatedAtMs: number;
  endedAtMs: number;
  partCount: number;
  stepStartCount: number;
  status: SubagentChild['status'];
  evidence: 'explicit' | 'ambiguous' | null;
  tokens?: SubagentTokens;
};

type RecoveredStatusEvidence = 'explicit' | 'ambiguous';

type RecoveredStatus = {
  status: SubagentChild['status'];
  endedAt?: string;
  updatedAt?: string;
  tokens?: SubagentTokens;
  evidence?: RecoveredStatusEvidence;
};

type MappedRecoveredChild = {
  child: SubagentChild;
  protectedTerminalSessionID?: string;
};

const NEVER_STARTED_HARD_STALE_AFTER_MS = 30 * 60_000;
const SQLITE_RECOVERY_TIMEOUT_MS = 2_000;

const READ_SQLITE_RECOVERY_SCRIPT = `
import json, sqlite3, sys

path = sys.argv[1]
parent_id = sys.argv[2]

# Mirror of the TypeScript status classification.
TERMINAL_STATUSES = {"done", "error"}
EXPLICIT_TYPES = {"session.error"}


def pick_time(time_obj, state_obj, keys):
    if isinstance(time_obj, dict):
        for key in keys:
            value = time_obj.get(key)
            if isinstance(value, (int, float)) and value > 0:
                return int(value)
            if isinstance(value, str) and value.strip():
                return value
    if isinstance(state_obj, dict):
        for key in keys:
            value = state_obj.get(key)
            if isinstance(value, (int, float)) and value > 0:
                return int(value)
            if isinstance(value, str) and value.strip():
                return value
    return None


def terminal_reason_from(value):
    if not isinstance(value, str):
        return None
    lowered = value.lower().strip()
    if lowered in ("done", "error"):
        return lowered
    for terminal in TERMINAL_STATUSES:
        if terminal in lowered:
            return terminal
    if lowered in ("completed", "complete", "success", "succeeded", "finished"):
        return "done"
    if lowered in ("failed", "failure", "cancelled", "canceled", "aborted", "abandoned"):
        return "error"
    return None


def normalize_time(value):
    if isinstance(value, (int, float)) and value > 0:
        return int(value)
    if isinstance(value, str) and value.strip():
        # Normalize to milliseconds since epoch.
        try:
            parsed = int(value)
            if parsed > 10_000_000_000:
                return parsed  # already ms
            return parsed * 1000  # seconds
        except ValueError:
            pass
    return None


def merge_token_field(target, key, value):
    if value is None:
        return target
    if key not in target or target[key] is None:
        target[key] = value
        return target
    try:
        existing = float(target[key])
        new = float(value)
        if new > existing:
            target[key] = value
    except (ValueError, TypeError):
        pass
    return target


def extract_part_tokens(part):
    if not isinstance(part, dict):
        return None
    raw = part.get("tokens")
    if not isinstance(raw, dict):
        return None
    out = {}
    int_fields = ("input", "output", "total", "reasoning", "cache_read", "cache_write")
    float_fields = ("contextPercent", "context_percent")
    for key in int_fields:
        value = raw.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)):
            out[key] = int(value)
        elif isinstance(value, str) and value.strip():
            try:
                out[key] = int(float(value))
            except ValueError:
                pass
    for key in float_fields:
        value = raw.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)):
            out[key] = float(value)
        elif isinstance(value, str) and value.strip():
            try:
                out[key] = float(value)
            except ValueError:
                pass
    return out or None


def classify_part(part, state_obj, now_ms):
    """Return (explicit_status_or_None, ended_ms, error_ms) for one part."""
    part_type = part.get("type")
    if part_type == "session.error":
        return "error", normalize_time(pick_time(part.get("time"), state_obj, ["end", "ended", "completed", "updated", "created"])) or now_ms, now_ms
    if isinstance(part_type, str) and (part_type.startswith("session.") or part_type == "completed"):
        explicit = terminal_reason_from(state_obj.get("status") if isinstance(state_obj, dict) else None) or terminal_reason_from(part.get("status")) or terminal_reason_from(part.get("state"))
        state_error = state_obj.get("error") if isinstance(state_obj, dict) else None
        if explicit is None and (state_error or part.get("error")):
            explicit = "error"
        if explicit is None:
            return None, None, None
        ended = normalize_time(pick_time(part.get("time"), state_obj, ["completed", "end", "ended", "updated", "created"])) or now_ms
        if explicit == "error":
            return explicit, ended, ended
        return explicit, ended, None
    if part_type == "step-finish":
        if part.get("error"):
            ended = normalize_time(pick_time(part.get("time"), state_obj, ["end", "ended", "updated", "created"])) or now_ms
            return None, None, ended
        reason = part.get("reason")
        if reason == "stop" or reason == "completed":
            ended = normalize_time(pick_time(part.get("time"), state_obj, ["end", "ended", "updated", "created"])) or now_ms
            return None, ended, None
        # Non-stop reasons (e.g., tool-calls) are not session terminal.
        return None, None, None
    return None, None, None


conn = sqlite3.connect(path)
conn.row_factory = sqlite3.Row
cur = conn.cursor()

rows = cur.execute(
    """
    SELECT
      s.id,
      s.parent_id,
      s.title,
      s.agent,
      s.time_created,
      s.time_updated,
      s.tokens_input,
      s.tokens_output,
      s.tokens_reasoning,
      s.tokens_cache_read,
      s.tokens_cache_write
    FROM session s
    WHERE s.parent_id = ?
    ORDER BY s.time_updated DESC, s.id DESC
    """,
    (parent_id,),
).fetchall()

# Aggregate per session, preserving insertion order (matches ORDER BY ASC of parts).
agg = {}  # session_id -> { explicit, completed_ms, error_ms, latest_step_start_ms, step_start_count, part_count, status, ended_ms, evidence, tokens }
for part_row in cur.execute(
    """
    SELECT p.session_id, p.data, p.time_created, p.time_updated
    FROM part p
    INNER JOIN session s ON s.id = p.session_id
    WHERE s.parent_id = ?
    ORDER BY p.session_id ASC, p.time_updated ASC, p.time_created ASC, p.id ASC
    """,
    (parent_id,),
).fetchall():
    sid = part_row[0]
    entry = agg.get(sid)
    if entry is None:
        entry = {
            "explicit": None,
            "completed_ms": 0,
            "error_ms": 0,
            "latest_step_start_ms": 0,
            "step_start_count": 0,
            "part_count": 0,
            "ambiguous_completed_ms": 0,
            "ambiguous_error_ms": 0,
            "tokens": {},
        }
        agg[sid] = entry
    entry["part_count"] += 1
    try:
        part = json.loads(part_row[1])
    except Exception:
        continue
    if not isinstance(part, dict):
        continue
    state_obj = part.get("state") if isinstance(part.get("state"), dict) else {}
    part_type = part.get("type")
    part_tokens = extract_part_tokens(part)
    if part_tokens:
        for tk, tv in part_tokens.items():
            merge_token_field(entry["tokens"], tk, tv)
    if part_type == "step-start":
        start_at = normalize_time(pick_time(part.get("time"), state_obj, ["start", "started", "created", "updated"]))
        if start_at is None:
            start_at = part_row[3] or 0
        if start_at:
            entry["latest_step_start_ms"] = max(entry["latest_step_start_ms"], start_at)
        entry["step_start_count"] += 1
        continue
    explicit, ended_ms, error_ms = classify_part(part, state_obj, part_row[3] or 0)
    if explicit is not None:
        entry["explicit"] = explicit
        if ended_ms is not None:
            if explicit == "error":
                entry["error_ms"] = max(entry["error_ms"], ended_ms)
            else:
                entry["completed_ms"] = max(entry["completed_ms"], ended_ms)
    # For step-finish without explicit error/terminal classification, fall back to row timestamp.
    if ended_ms is None and part_type == "step-finish":
        ended_ms = part_row[3] or 0
    if ended_ms is not None:
        # Ambiguous step-finish stop: track separately for guard.
        if part_type == "step-finish" and (part.get("reason") == "stop" or part.get("reason") == "completed"):
            entry["ambiguous_completed_ms"] = max(entry["ambiguous_completed_ms"], ended_ms)
    if error_ms is None and part_type == "step-finish" and part.get("error"):
        error_ms = part_row[3] or 0
    if error_ms is not None:
        entry["ambiguous_error_ms"] = max(entry.get("ambiguous_error_ms", 0), error_ms)


def to_ms(value):
    return int(value) if isinstance(value, (int, float)) and value > 0 else 0


result = []
for row in rows:
    sid = row[0]
    entry = agg.get(sid, {})
    explicit = entry.get("explicit")
    completed_ms = to_ms(entry.get("completed_ms"))
    error_ms = to_ms(entry.get("error_ms"))
    ambiguous_completed_ms = to_ms(entry.get("ambiguous_completed_ms"))
    ambiguous_error_ms = to_ms(entry.get("ambiguous_error_ms"))
    latest_step_start_ms = to_ms(entry.get("latest_step_start_ms"))
    part_count = int(entry.get("part_count", 0))
    step_start_count = int(entry.get("step_start_count", 0))
    row_updated_ms = int(row[5]) if row[5] is not None else 0

    # Merge row-level token columns with per-part tokens (parts win when newer).
    tokens = {}
    for key, idx in (("input", 6), ("output", 7), ("reasoning", 8), ("cache_read", 9), ("cache_write", 10)):
        if row[idx] is not None:
            try:
                tokens[key] = int(row[idx])
            except (ValueError, TypeError):
                pass
    part_tokens = entry.get("tokens") or {}
    for key, value in part_tokens.items():
        if key in ("input", "output", "total", "reasoning", "cache_read", "cache_write", "contextPercent", "context_percent") and value is not None:
            merge_token_field(tokens, key, value)
    if not tokens:
        tokens = None

    if explicit == "error" and error_ms > 0:
        status = "error"
        evidence = "explicit"
        ended_ms = error_ms
    elif completed_ms > 0 and (explicit == "done" or completed_ms >= error_ms):
        status = "done"
        evidence = "explicit"
        ended_ms = completed_ms
    elif error_ms > completed_ms and error_ms > 0:
        status = "error"
        evidence = "explicit"
        ended_ms = error_ms
    elif ambiguous_completed_ms > 0 and ambiguous_completed_ms >= latest_step_start_ms and ambiguous_completed_ms >= ambiguous_error_ms:
        status = "done"
        evidence = "ambiguous"
        ended_ms = ambiguous_completed_ms
    elif ambiguous_error_ms > 0 and ambiguous_error_ms > ambiguous_completed_ms:
        status = "error"
        evidence = "ambiguous"
        ended_ms = ambiguous_error_ms
    else:
        status = "running"
        evidence = None
        ended_ms = 0

    result.append(
        {
            "id": sid,
            "parentID": row[1],
            "title": row[2],
            "agentName": row[3],
            "startedAtMs": int(row[4]) if row[4] is not None else 0,
            "updatedAtMs": row_updated_ms,
            "endedAtMs": ended_ms,
            "tokens": tokens,
            "partCount": part_count,
            "stepStartCount": step_start_count,
            "status": status,
            "evidence": evidence,
        }
    )

open("/tmp/subagent-recovery-ran.txt", "w").close()
print(json.dumps(result))
`;

const toISOString = (timestampMs: number): string => {
  return new Date(timestampMs).toISOString();
};

const resolveOpenCodeDatabasePath = (): string => {
  const baseDir = process.env.XDG_DATA_HOME ?? join(os.homedir(), '.local', 'share');
  return join(baseDir, 'opencode', 'opencode.db');
};

const resolvePartTerminalTimestamp = (part: Record<string, unknown>): string | undefined => {
  const state = isRecord(part.state) ? part.state : undefined;
  const time = isRecord(part.time) ? part.time : undefined;

  return (
    timestampFromUnknown(time?.end) ??
    timestampFromUnknown(time?.ended) ??
    timestampFromUnknown(time?.completed) ??
    timestampFromUnknown(time?.updated) ??
    timestampFromUnknown(state?.completed) ??
    timestampFromUnknown(state?.ended) ??
    timestampFromUnknown(state?.end) ??
    timestampFromUnknown(state?.updated)
  );
};

const resolvePartStartTimestamp = (part: Record<string, unknown>): string | undefined => {
  const state = isRecord(part.state) ? part.state : undefined;
  const time = isRecord(part.time) ? part.time : undefined;

  return (
    timestampFromUnknown(time?.start) ??
    timestampFromUnknown(time?.started) ??
    timestampFromUnknown(time?.created) ??
    timestampFromUnknown(time?.updated) ??
    timestampFromUnknown(state?.started) ??
    timestampFromUnknown(state?.start) ??
    timestampFromUnknown(state?.created) ??
    timestampFromUnknown(state?.updated)
  );
};

const resolveExplicitSessionTerminalStatus = (
  part: Record<string, unknown>,
  state: Record<string, unknown> | undefined,
): Exclude<SubagentChild['status'], 'running'> | undefined => {
  const type = normalizedString(part.type);
  if (type === 'session.error') return 'error';

  const isSessionScopedTerminal = Boolean(type && (type.startsWith('session.') || type === 'completed'));
  if (!isSessionScopedTerminal) return undefined;

  return (
    deriveTerminalSessionStatus(state?.status ?? part.status ?? state ?? part) ??
    (part.error || state?.error ? 'error' : undefined)
  );
};

const resolveAmbiguousStepFinishStatus = (part: Record<string, unknown>): 'done' | 'error' | undefined => {
  if (normalizedString(part.type) !== 'step-finish') return undefined;
  if (part.error) return 'error';

  const reason = normalizedString(part.reason ?? part.status ?? part.state);
  const terminalReason = deriveTerminalSessionStatus(reason);
  if (terminalReason === 'done' || terminalReason === 'error') return terminalReason;

  return reason === 'stop' ? 'done' : undefined;
};

export const resolveRecoveredStatus = (parts: readonly unknown[]): RecoveredStatus => {
  let completedAtMs = 0;
  let errorAtMs = 0;
  let ambiguousCompletedAtMs = 0;
  let ambiguousErrorAtMs = 0;
  let latestStepStartAtMs = 0;
  let fallbackTerminalStatus: Exclude<SubagentChild['status'], 'running'> | undefined;
  let fallbackTerminalTokens: SubagentTokens | undefined;
  let latestTokens: SubagentTokens | undefined;
  let completedTokens: SubagentTokens | undefined;
  let errorTokens: SubagentTokens | undefined;

  if (parts.length === 0) {
    return { status: 'running', updatedAt: undefined, endedAt: undefined, tokens: undefined };
  }

  for (const part of parts) {
    if (!isRecord(part)) continue;

    const state = isRecord(part.state) ? part.state : undefined;
    const rawTokens = normalizeSubagentTokens(part.tokens);
    latestTokens = mergeSubagentTokens(latestTokens, rawTokens);

    if (normalizedString(part.type) === 'step-start') {
      const startedAt = resolvePartStartTimestamp(part);
      if (startedAt) {
        const startedAtMs = Date.parse(startedAt);
        latestStepStartAtMs = Number.isNaN(startedAtMs)
          ? latestStepStartAtMs
          : Math.max(latestStepStartAtMs, startedAtMs);
      }
    }

    const status = resolveExplicitSessionTerminalStatus(part, state);
    if (!status) {
      const ambiguousStatus = resolveAmbiguousStepFinishStatus(part);
      if (!ambiguousStatus) continue;

      const endedAt = resolvePartTerminalTimestamp(part);
      if (!endedAt) continue;

      const endedAtMs = Date.parse(endedAt);
      if (Number.isNaN(endedAtMs)) continue;

      if (ambiguousStatus === 'error') {
        if (endedAtMs >= ambiguousErrorAtMs) {
          ambiguousErrorAtMs = endedAtMs;
          errorTokens = mergeSubagentTokens(errorTokens, rawTokens);
        }
        continue;
      }

      if (endedAtMs >= ambiguousCompletedAtMs) {
        ambiguousCompletedAtMs = endedAtMs;
        completedTokens = mergeSubagentTokens(completedTokens, rawTokens);
      }
      continue;
    }

    const endedAt = resolvePartTerminalTimestamp(part);
    if (!endedAt) {
      fallbackTerminalStatus = status;
      fallbackTerminalTokens = mergeSubagentTokens(fallbackTerminalTokens, rawTokens);
      continue;
    }

    const endedAtMs = Date.parse(endedAt);
    if (status === 'error') {
      if (endedAtMs >= errorAtMs) {
        errorAtMs = endedAtMs;
        errorTokens = mergeSubagentTokens(errorTokens, rawTokens);
      }

      continue;
    }

    if (endedAtMs >= completedAtMs) {
      completedAtMs = endedAtMs;
      completedTokens = mergeSubagentTokens(completedTokens, rawTokens);
    }
  }

  if (errorAtMs > completedAtMs) {
    const endedAt = toISOString(errorAtMs);

    return {
      status: 'error',
      updatedAt: endedAt,
      endedAt,
      tokens: mergeSubagentTokens(latestTokens, errorTokens),
      evidence: 'explicit',
    };
  }

  if (completedAtMs > 0) {
    const endedAt = toISOString(completedAtMs);

    return {
      status: 'done',
      updatedAt: endedAt,
      endedAt,
      tokens: mergeSubagentTokens(latestTokens, completedTokens),
      evidence: 'explicit',
    };
  }

  if (fallbackTerminalStatus) {
    return {
      status: fallbackTerminalStatus,
      updatedAt: undefined,
      endedAt: undefined,
      tokens: mergeSubagentTokens(latestTokens, fallbackTerminalTokens),
      evidence: 'explicit',
    };
  }

  const ambiguousStatus = ambiguousErrorAtMs > ambiguousCompletedAtMs ? 'error' : 'done';
  const ambiguousAtMs = Math.max(ambiguousCompletedAtMs, ambiguousErrorAtMs);
  if (ambiguousAtMs > 0 && ambiguousAtMs >= latestStepStartAtMs) {
    const endedAt = toISOString(ambiguousAtMs);

    return {
      status: ambiguousStatus,
      updatedAt: endedAt,
      endedAt,
      tokens: mergeSubagentTokens(latestTokens, ambiguousStatus === 'error' ? errorTokens : completedTokens),
      evidence: 'ambiguous',
    };
  }

  return {
    status: 'running',
    updatedAt: undefined,
    endedAt: undefined,
    tokens: latestTokens,
  };
};

const runSQLiteRecoveryScript = (databasePath: string, parentSessionID: string): string | undefined => {
  debugLog(`[subagent-status] runSQLiteRecoveryScript called: db=${databasePath} parent=${parentSessionID}`);
  const result = spawnSync('python3', ['-c', READ_SQLITE_RECOVERY_SCRIPT, databasePath, parentSessionID], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: SQLITE_RECOVERY_TIMEOUT_MS,
  });

  debugLog(
    `[subagent-status] python result: status=${result.status} stdout_len=${result.stdout?.length ?? 0} stderr=${result.stderr?.slice(0, 200) ?? ''}`,
  );
  return result.status === 0 && result.stdout.trim() ? result.stdout : undefined;
};

const normalizeSQLiteRecoveryRow = (input: unknown): SQLiteRecoveryRow | undefined => {
  if (!isRecord(input)) return undefined;

  const id = asString(input.id);
  const parentID = asString(input.parentID);
  const title = asString(input.title);
  const startedAtMs = toFiniteNumber(input.startedAtMs);
  const updatedAtMs = toFiniteNumber(input.updatedAtMs);
  if (!id || !parentID || !title || startedAtMs === undefined || updatedAtMs === undefined) {
    return undefined;
  }

  const endedAtMs = toFiniteNumber(input.endedAtMs) ?? 0;
  const rawStatus = asString(input.status);
  const status: SubagentChild['status'] =
    rawStatus === 'done' || rawStatus === 'error' || rawStatus === 'running' ? rawStatus : 'running';
  const rawEvidence = asString(input.evidence);
  const evidence: SQLiteRecoveryRow['evidence'] =
    rawEvidence === 'explicit' || rawEvidence === 'ambiguous' ? rawEvidence : null;

  return {
    id,
    parentID,
    title,
    agentName: asString(input.agentName),
    startedAtMs,
    updatedAtMs,
    endedAtMs,
    partCount: Math.max(0, Math.floor(toFiniteNumber(input.partCount) ?? 0)),
    stepStartCount: Math.max(0, Math.floor(toFiniteNumber(input.stepStartCount) ?? 0)),
    status,
    evidence,
    tokens: normalizeSubagentTokens(input.tokens),
  };
};

export const readSQLiteRecoveryRows = async (
  databasePath: string,
  parentSessionID: string,
): Promise<SQLiteRecoveryRow[]> => {
  if (!existsSync(databasePath)) return [];

  const stdout = runSQLiteRecoveryScript(databasePath, parentSessionID);
  if (!stdout) return [];

  try {
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed.map(normalizeSQLiteRecoveryRow).filter((row) => row !== undefined) : [];
  } catch {
    return [];
  }
};

export const safeParseParts = (values: readonly string[]): unknown[] => {
  const parts: unknown[] = [];

  for (const value of values) {
    try {
      parts.push(JSON.parse(value));
    } catch {
      parts.push(undefined);
    }
  }

  return parts;
};

const mapRecoveredChild = (row: SQLiteRecoveryRow, hardStaleAfterMs: number): MappedRecoveredChild => {
  const nowMs = Date.now();
  const isNeverStartedRunningFallback =
    row.status === 'running' && (row.partCount === 0 || (row.partCount > 0 && row.stepStartCount === 0));
  const runningHardStaleAfterMs =
    hardStaleAfterMs > 0 && isNeverStartedRunningFallback
      ? Math.min(hardStaleAfterMs, NEVER_STARTED_HARD_STALE_AFTER_MS)
      : hardStaleAfterMs;
  const isAbandonedRunningFallback =
    runningHardStaleAfterMs > 0 && row.status === 'running' && nowMs - row.updatedAtMs >= runningHardStaleAfterMs;
  const recoveredAtMs = isAbandonedRunningFallback ? Math.max(nowMs, row.updatedAtMs) : row.updatedAtMs;
  const endedAtMsFromRow = row.endedAtMs > 0 ? row.endedAtMs : recoveredAtMs;
  const updatedAt = toISOString(recoveredAtMs);
  const status: SubagentChild['status'] = isAbandonedRunningFallback ? 'error' : row.status;
  const endedAt = isAbandonedRunningFallback ? updatedAt : toISOString(endedAtMsFromRow);
  const protectedTerminalSessionID =
    status !== 'running' && row.evidence !== null && !isAbandonedRunningFallback ? row.id : undefined;

  return {
    child: {
      id: row.id,
      title: row.title,
      agentName: row.agentName,
      parentID: row.parentID,
      source: 'session',
      targetSessionID: row.id,
      status,
      startedAt: toISOString(row.startedAtMs),
      updatedAt,
      endedAt,
      tokens: row.tokens,
    },
    protectedTerminalSessionID,
  };
};

export const createSQLiteRecoverySource = (
  input: { databasePath?: string; hardStaleAfterMs?: number } = {},
): RecoverySource => {
  const databasePath = input.databasePath ?? resolveOpenCodeDatabasePath();
  const hardStaleAfterMs = Math.max(
    0,
    Math.floor(input.hardStaleAfterMs ?? DEFAULT_STALE_RUNNING_PROBE_POLICY.hardStaleAfterMs),
  );

  return {
    hydrateState: async (state: SubagentState, context: RecoveryContext): Promise<RecoveryResult | undefined> => {
      const parentSessionID = context.parentSessionID;
      if (!parentSessionID) {
        debugLog('[subagent-status] hydrateState: no parentSessionID, skipping');
        return undefined;
      }

      debugLog(`[subagent-status] hydrateState: parent=${parentSessionID} db=${databasePath}`);
      const rows = await readSQLiteRecoveryRows(databasePath, parentSessionID);
      debugLog(`[subagent-status] hydrateState: rows=${rows.length}`);
      if (rows.length === 0) return undefined;

      const mappedChildren = rows.map((row) => mapRecoveredChild(row, hardStaleAfterMs));
      const statuses = mappedChildren.map(({ child }) => child.status);
      debugLog(`[subagent-status] hydrateState: statuses=${JSON.stringify(statuses)}`);

      return applyRecoveredChildren(
        state,
        mappedChildren.map(({ child }) => child),
        rows.map((row) => row.id),
        parentSessionID,
        {
          protectedTerminalSessionIDs: mappedChildren
            .map(({ protectedTerminalSessionID }) => protectedTerminalSessionID)
            .filter((sessionId): sessionId is string => Boolean(sessionId)),
        },
      );
    },
  };
};
