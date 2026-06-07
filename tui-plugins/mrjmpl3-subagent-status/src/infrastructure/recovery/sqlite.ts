import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

import type { SubagentChild, SubagentState, SubagentTokens } from '../../domain/types.ts';
import { normalizeSubagentTokens } from '../../domain/tokens.ts';
import { deriveTerminalSessionStatus } from '../../domain/session-status.ts';
import { asString, isRecord, timestampFromUnknown, toFiniteNumber } from '../../shared/coercion.ts';

import { applyRecoveredChildren } from '../recovery.ts';
import type { RecoveryContext, RecoveryResult, RecoverySource } from '../recovery.ts';

type SQLiteRecoveryRow = {
  id: string;
  parentID: string;
  title: string;
  agentName?: string;
  startedAtMs: number;
  updatedAtMs: number;
  latestPart?: string;
  tokens?: SubagentTokens;
};

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
    WITH latest_parts AS (
      SELECT
        p.session_id,
        p.data,
        ROW_NUMBER() OVER (PARTITION BY p.session_id ORDER BY p.time_updated DESC, p.time_created DESC, p.id DESC) AS row_number
      FROM part p
      INNER JOIN session s ON s.id = p.session_id
      WHERE s.parent_id = ?
    )
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
      s.tokens_cache_write,
      lp.data AS latest_part
    FROM session s
    LEFT JOIN latest_parts lp ON lp.session_id = s.id AND lp.row_number = 1
    WHERE s.parent_id = ?
    ORDER BY s.time_updated DESC, s.id DESC
    """,
    (parent_id, parent_id),
).fetchall()

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
            "latestPart": row[11],
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

const resolveRecoveredStatus = (
  latestPart: unknown,
): {
  status: SubagentChild['status'];
  endedAt?: string;
  updatedAt?: string;
  tokens?: SubagentTokens;
} => {
  if (!isRecord(latestPart)) {
    return { status: 'running', updatedAt: undefined, endedAt: undefined, tokens: undefined };
  }

  const part = latestPart;
  const state = isRecord(part.state) ? part.state : undefined;
  const rawTokens = normalizeSubagentTokens(part.tokens);
  const time = isRecord(part.time) ? part.time : undefined;
  const endedAt =
    timestampFromUnknown(time?.end) ??
    timestampFromUnknown(time?.ended) ??
    timestampFromUnknown(time?.completed) ??
    timestampFromUnknown(time?.updated);
  const terminalStatus =
    deriveTerminalSessionStatus(state?.status ?? part.status ?? state ?? part) ??
    (part.error || state?.error ? 'error' : undefined);

  if (part.type === 'step-finish' && part.reason === 'stop') {
    return {
      status: 'done',
      updatedAt: endedAt,
      endedAt,
      tokens: rawTokens,
    };
  }

  if (terminalStatus) {
    return {
      status: terminalStatus,
      updatedAt: endedAt,
      endedAt,
      tokens: rawTokens,
    };
  }

  return {
    status: 'running',
    updatedAt: undefined,
    endedAt: undefined,
    tokens: rawTokens,
  };
};

const runSQLiteRecoveryScript = (databasePath: string, parentSessionID: string): string | undefined => {
  const result = spawnSync('python3', ['-c', READ_SQLITE_RECOVERY_SCRIPT, databasePath, parentSessionID], {
    encoding: 'utf8',
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
    latestPart: asString(input.latestPart),
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

const safeParseLatestPart = (value: string | undefined): unknown => {
  if (!value) return undefined;

  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

const mapRecoveredChild = (row: SQLiteRecoveryRow): SubagentChild => {
  const latestPart = safeParseLatestPart(row.latestPart);
  const resolved = resolveRecoveredStatus(latestPart);
  const updatedAt = resolved.updatedAt ?? toISOString(row.updatedAtMs);

  return {
    id: row.id,
    title: row.title,
    agentName: row.agentName,
    parentID: row.parentID,
    source: 'session',
    targetSessionID: row.id,
    status: resolved.status,
    startedAt: toISOString(row.startedAtMs),
    updatedAt,
    endedAt: resolved.endedAt,
    tokens: mergeTokens(row.tokens, resolved.tokens),
  };
};

export const createSQLiteRecoverySource = (input: { databasePath?: string } = {}): RecoverySource => {
  const databasePath = input.databasePath ?? resolveOpenCodeDatabasePath();

  return {
    hydrateState: async (state: SubagentState, context: RecoveryContext): Promise<RecoveryResult | undefined> => {
      const parentSessionID = context.parentSessionID;
      if (!parentSessionID) return undefined;

      const rows = await readSQLiteRecoveryRows(databasePath, parentSessionID);
      if (rows.length === 0) return undefined;

      return applyRecoveredChildren(
        state,
        rows.map(mapRecoveredChild),
        rows.map((row) => row.id),
        parentSessionID,
      );
    },
  };
};
