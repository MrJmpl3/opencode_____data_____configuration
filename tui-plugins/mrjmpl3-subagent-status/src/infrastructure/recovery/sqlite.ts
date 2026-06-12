import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

import type { SubagentChild, SubagentState, SubagentTokens } from '../../domain/types.ts';
import { normalizeSubagentTokens } from '../../domain/tokens.ts';
import { deriveTerminalSessionStatus } from '../../domain/session-status.ts';
import { asString, isRecord, timestampFromUnknown, toFiniteNumber } from '../../shared/coercion.ts';
import { DEFAULT_STALE_RUNNING_PROBE_POLICY } from '../../runtime/options.ts';

import { applyRecoveredChildren } from '../recovery.ts';
import type { RecoveryContext, RecoveryResult, RecoverySource } from '../recovery.ts';

type SQLiteRecoveryRow = {
  id: string;
  parentID: string;
  title: string;
  agentName?: string;
  startedAtMs: number;
  updatedAtMs: number;
  partCount: number;
  stepStartCount: number;
  parts: string[];
  tokens?: SubagentTokens;
};

const NEVER_STARTED_HARD_STALE_AFTER_MS = 30 * 60_000;

const mergeTokens = (
  existing: SubagentTokens | undefined,
  incoming: SubagentTokens | undefined,
): SubagentTokens | undefined => {
  if (!existing && !incoming) return undefined;

  return {
    input: incoming?.input ?? existing?.input,
    output: incoming?.output ?? existing?.output,
    total: incoming?.total ?? existing?.total,
    contextPercent: incoming?.contextPercent ?? existing?.contextPercent,
  };
};

const READ_SQLITE_RECOVERY_SCRIPT = `
import json, sqlite3, sys

path = sys.argv[1]
parent_id = sys.argv[2]

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

part_rows = cur.execute(
    """
    SELECT p.session_id, p.data
    FROM part p
    INNER JOIN session s ON s.id = p.session_id
    WHERE s.parent_id = ?
    ORDER BY p.session_id ASC, p.time_updated ASC, p.time_created ASC, p.id ASC
    """,
    (parent_id,),
).fetchall()

parts_by_session = {}
part_counts = {}
step_start_counts = {}
for part_row in part_rows:
    try:
        part = json.loads(part_row[1])
    except Exception:
        continue

    if not isinstance(part, dict):
        continue

    part_type = part.get("type")
    part_counts[part_row[0]] = part_counts.get(part_row[0], 0) + 1
    if part_type == "step-start":
        step_start_counts[part_row[0]] = step_start_counts.get(part_row[0], 0) + 1

    has_recovery_evidence = (
        part_type in ("step-finish", "session.status")
        or part.get("status") is not None
        or part.get("state") is not None
        or part.get("error") is not None
        or part.get("tokens") is not None
    )
    if not has_recovery_evidence:
        continue

    parts_by_session.setdefault(part_row[0], []).append(json.dumps(part, separators=(",", ":")))

result = []
for row in rows:
    tokens = {
        "input": row[6],
        "output": row[7],
        "total": None,
    }
    if tokens["input"] is None and tokens["output"] is None and tokens["total"] is None:
        tokens = None

    result.append(
        {
            "id": row[0],
            "parentID": row[1],
            "title": row[2],
            "agentName": row[3],
            "startedAtMs": row[4],
            "updatedAtMs": row[5],
            "tokens": tokens,
            "partCount": part_counts.get(row[0], 0),
            "stepStartCount": step_start_counts.get(row[0], 0),
            "parts": parts_by_session.get(row[0], []),
        }
    )

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

export const resolveRecoveredStatus = (
  parts: readonly unknown[],
): {
  status: SubagentChild['status'];
  endedAt?: string;
  updatedAt?: string;
  tokens?: SubagentTokens;
} => {
  let completedAtMs = 0;
  let errorAtMs = 0;
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
    latestTokens = mergeTokens(latestTokens, rawTokens);

    const terminalStatus =
      deriveTerminalSessionStatus(state?.status ?? part.status ?? state ?? part) ??
      (part.error || state?.error ? 'error' : undefined);
    const isNormalStop = part.type === 'step-finish' && part.reason === 'stop';
    const status = isNormalStop ? 'done' : terminalStatus;
    if (!status) continue;

    const endedAt = resolvePartTerminalTimestamp(part);
    if (!endedAt) {
      fallbackTerminalStatus = status;
      fallbackTerminalTokens = mergeTokens(fallbackTerminalTokens, rawTokens);
      continue;
    }

    const endedAtMs = Date.parse(endedAt);
    if (status === 'error') {
      if (endedAtMs >= errorAtMs) {
        errorAtMs = endedAtMs;
        errorTokens = mergeTokens(errorTokens, rawTokens);
      }

      continue;
    }

    if (endedAtMs >= completedAtMs) {
      completedAtMs = endedAtMs;
      completedTokens = mergeTokens(completedTokens, rawTokens);
    }
  }

  if (errorAtMs > completedAtMs) {
    const endedAt = toISOString(errorAtMs);

    return {
      status: 'error',
      updatedAt: endedAt,
      endedAt,
      tokens: mergeTokens(latestTokens, errorTokens),
    };
  }

  if (completedAtMs > 0) {
    const endedAt = toISOString(completedAtMs);

    return {
      status: 'done',
      updatedAt: endedAt,
      endedAt,
      tokens: mergeTokens(latestTokens, completedTokens),
    };
  }

  if (fallbackTerminalStatus) {
    return {
      status: fallbackTerminalStatus,
      updatedAt: undefined,
      endedAt: undefined,
      tokens: mergeTokens(latestTokens, fallbackTerminalTokens),
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
  const result = spawnSync('python3', ['-c', READ_SQLITE_RECOVERY_SCRIPT, databasePath, parentSessionID], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });

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

  return {
    id,
    parentID,
    title,
    agentName: asString(input.agentName),
    startedAtMs,
    updatedAtMs,
    partCount: Math.max(0, Math.floor(toFiniteNumber(input.partCount) ?? 0)),
    stepStartCount: Math.max(0, Math.floor(toFiniteNumber(input.stepStartCount) ?? 0)),
    parts: Array.isArray(input.parts) ? input.parts.map(asString).filter((part) => part !== undefined) : [],
    tokens: normalizeSubagentTokens(input.tokens),
  };
};

const readSQLiteRecoveryRows = async (databasePath: string, parentSessionID: string): Promise<SQLiteRecoveryRow[]> => {
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

const mapRecoveredChild = (row: SQLiteRecoveryRow, hardStaleAfterMs: number): SubagentChild => {
  const parts = safeParseParts(row.parts);
  const resolved = resolveRecoveredStatus(parts);
  const nowMs = Date.now();
  const isNeverStartedRunningFallback =
    resolved.status === 'running' && (parts.length === 0 || (row.partCount > 0 && row.stepStartCount === 0));
  const runningHardStaleAfterMs =
    hardStaleAfterMs > 0 && isNeverStartedRunningFallback
      ? Math.min(hardStaleAfterMs, NEVER_STARTED_HARD_STALE_AFTER_MS)
      : hardStaleAfterMs;
  const isAbandonedRunningFallback =
    runningHardStaleAfterMs > 0 && resolved.status === 'running' && nowMs - row.updatedAtMs >= runningHardStaleAfterMs;
  const recoveredAtMs = isAbandonedRunningFallback ? Math.max(nowMs, row.updatedAtMs) : row.updatedAtMs;
  const updatedAt = resolved.updatedAt ?? toISOString(recoveredAtMs);
  const status = isAbandonedRunningFallback ? 'error' : resolved.status;
  const endedAt = isAbandonedRunningFallback ? updatedAt : resolved.endedAt;

  return {
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
    tokens: mergeTokens(row.tokens, resolved.tokens),
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
      if (!parentSessionID) return undefined;

      const rows = await readSQLiteRecoveryRows(databasePath, parentSessionID);
      if (rows.length === 0) return undefined;

      return applyRecoveredChildren(
        state,
        rows.map((row) => mapRecoveredChild(row, hardStaleAfterMs)),
        rows.map((row) => row.id),
        parentSessionID,
      );
    },
  };
};
