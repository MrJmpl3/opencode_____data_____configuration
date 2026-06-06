import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

import type { SubagentChild, SubagentState, SubagentTokens } from '../../domain/types.ts';
import { deriveTerminalSessionStatus } from '../../domain/session-status.ts';

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
        "total": sum(value or 0 for value in row[6:11]) or None,
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

function toISOString(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function timestampFromUnknown(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const millis = value < 10_000_000_000 ? value * 1000 : value;
    return toISOString(millis);
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
  }

  return undefined;
}

function resolveOpenCodeDatabasePath(): string {
  const baseDir = process.env.XDG_DATA_HOME ?? join(os.homedir(), '.local', 'share');
  return join(baseDir, 'opencode', 'opencode.db');
}

function resolveRecoveredStatus(latestPart: unknown): {
  status: SubagentChild['status'];
  endedAt?: string;
  updatedAt?: string;
  tokens?: SubagentTokens;
} {
  if (!isRecord(latestPart)) {
    return { status: 'running', updatedAt: undefined, endedAt: undefined, tokens: undefined };
  }

  const part = latestPart;
  const state = isRecord(part.state) ? part.state : undefined;
  const rawTokens =
    typeof part.tokens === 'object' && part.tokens !== null ? (part.tokens as SubagentTokens) : undefined;
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
}

function readSQLiteRecoveryRows(databasePath: string, parentSessionID: string): SQLiteRecoveryRow[] {
  if (!existsSync(databasePath)) return [];

  const result = spawnSync('python3', ['-c', READ_SQLITE_RECOVERY_SCRIPT, databasePath, parentSessionID], {
    encoding: 'utf8',
  });

  if (result.status !== 0 || !result.stdout.trim()) return [];

  try {
    const parsed = JSON.parse(result.stdout) as SQLiteRecoveryRow[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mapRecoveredChild(row: SQLiteRecoveryRow): SubagentChild {
  const latestPart = row.latestPart ? JSON.parse(row.latestPart) : undefined;
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
    tokens: resolved.tokens ?? row.tokens,
  };
}

export function createSQLiteRecoverySource(input: { databasePath?: string } = {}): RecoverySource {
  const databasePath = input.databasePath ?? resolveOpenCodeDatabasePath();

  return {
    async hydrateState(state: SubagentState, context: RecoveryContext): Promise<RecoveryResult | undefined> {
      const parentSessionID = context.parentSessionID;
      if (!parentSessionID) return undefined;

      const rows = readSQLiteRecoveryRows(databasePath, parentSessionID);
      if (rows.length === 0) return undefined;

      return applyRecoveredChildren(
        state,
        rows.map(mapRecoveredChild),
        rows.map((row) => row.id),
        parentSessionID,
      );
    },
  };
}
