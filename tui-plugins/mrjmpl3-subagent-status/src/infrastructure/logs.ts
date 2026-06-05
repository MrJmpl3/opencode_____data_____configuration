import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

import type { SubagentTokens } from '../domain/types.ts';

const MAX_SYNC_LOG_READ_BYTES = 1024 * 1024;
const DONE_TOKEN_REHYDRATE_THROTTLE_MS = 2000;
const DONE_TOKEN_REHYDRATE_MAX_ATTEMPTS = 15;
const DONE_TOKEN_CACHE_TTL_MS = 30 * 60 * 1000;
const DONE_TOKEN_CACHE_MAX_ENTRIES = 64;

type DoneTokenCacheEntry = {
  attempts: number;
  checkedAtMs: number;
  tokens?: SubagentTokens;
};

const doneTokenCache = new Map<string, DoneTokenCacheEntry>();

function pruneDoneTokenCache(nowMs: number): void {
  for (const [sessionID, entry] of doneTokenCache) {
    if (nowMs - entry.checkedAtMs <= DONE_TOKEN_CACHE_TTL_MS) continue;
    doneTokenCache.delete(sessionID);
  }

  while (doneTokenCache.size > DONE_TOKEN_CACHE_MAX_ENTRIES) {
    const oldestSessionID = doneTokenCache.keys().next().value;
    if (typeof oldestSessionID !== 'string') break;
    doneTokenCache.delete(oldestSessionID);
  }
}

function safeRead<T>(reader: () => T): T | undefined {
  try {
    return reader();
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizePercent(value: number): number {
  if (value > 0 && value <= 1) {
    return value * 100;
  }

  return value;
}

function mergeTokens(
  existing: SubagentTokens | undefined,
  incoming: SubagentTokens | undefined,
): SubagentTokens | undefined {
  if (!existing && !incoming) return undefined;
  return {
    input: incoming?.input ?? existing?.input,
    output: incoming?.output ?? existing?.output,
    total: incoming?.total ?? existing?.total,
    contextPercent: incoming?.contextPercent ?? existing?.contextPercent,
  };
}

function hasUsableTokens(tokens: SubagentTokens | undefined): boolean {
  return Boolean(
    typeof tokens?.input === 'number' ||
    typeof tokens?.output === 'number' ||
    typeof tokens?.total === 'number' ||
    typeof tokens?.contextPercent === 'number',
  );
}

function sanitizeTokens(input: unknown): SubagentTokens | undefined {
  if (!isRecord(input)) return undefined;

  const tokens: SubagentTokens = {
    input: toFiniteNumber(input.input),
    output: toFiniteNumber(input.output),
    total: toFiniteNumber(input.total),
    contextPercent: toFiniteNumber(input.contextPercent),
  };

  if (
    tokens.input === undefined &&
    tokens.output === undefined &&
    tokens.total === undefined &&
    tokens.contextPercent === undefined
  ) {
    return undefined;
  }

  return tokens;
}

function extractTokenHints(input: unknown): SubagentTokens | undefined {
  const tokenHints: SubagentTokens = {};
  const visited = new Set<object>();

  const walk = (node: unknown, depth: number): void => {
    if (depth > 6 || node === null || node === undefined) return;

    if (Array.isArray(node)) {
      for (const value of node) {
        walk(value, depth + 1);
      }
      return;
    }

    if (!isRecord(node)) return;
    if (visited.has(node)) return;
    visited.add(node);

    for (const [rawKey, rawValue] of Object.entries(node)) {
      const key = rawKey.toLowerCase();
      const asNumber = toFiniteNumber(rawValue);

      if (key === 'tokens' || key === 'token') {
        if (typeof asNumber === 'number') {
          tokenHints.total = asNumber;
        } else {
          Object.assign(tokenHints, mergeTokens(tokenHints, sanitizeTokens(rawValue)));
        }
      }

      if (typeof asNumber === 'number') {
        if (key.includes('context') && (key.includes('percent') || key.includes('usage'))) {
          tokenHints.contextPercent = normalizePercent(asNumber);
        } else if ((key.includes('input') || key.includes('prompt')) && key.includes('token')) {
          tokenHints.input = asNumber;
        } else if ((key.includes('output') || key.includes('completion')) && key.includes('token')) {
          tokenHints.output = asNumber;
        } else if (key.includes('total') && key.includes('token')) {
          tokenHints.total = asNumber;
        }
      }

      if (isRecord(rawValue) || Array.isArray(rawValue)) {
        walk(rawValue, depth + 1);
      }
    }
  };

  walk(input, 0);

  return hasUsableTokens(tokenHints) ? tokenHints : undefined;
}

function extractJsonPayloads(line: string): unknown[] {
  const payloads: unknown[] = [];
  const starts = [...line.matchAll(/\{/g)].map((match) => match.index ?? -1).filter((index) => index >= 0);

  for (const start of starts) {
    const parsed = safeRead(() => JSON.parse(line.slice(start)));
    if (parsed !== undefined) {
      payloads.push(parsed);
      break;
    }
  }

  return payloads;
}

function resolveOpenCodeDataDir(): string {
  const baseDir = process.env.XDG_DATA_HOME ?? join(os.homedir(), '.local', 'share');
  return join(baseDir, 'opencode');
}

function resolveOpenCodeLogDir(): string {
  return join(resolveOpenCodeDataDir(), 'log');
}

function extractTokensFromLine(line: string): SubagentTokens | undefined {
  let tokens: SubagentTokens | undefined;

  for (const payload of extractJsonPayloads(line)) {
    tokens = mergeTokens(tokens, extractTokenHints(payload));
  }

  return hasUsableTokens(tokens) ? tokens : undefined;
}

export function readOpenCodeLogFileIfSmall(path: string): string | undefined {
  const stats = safeRead(() => statSync(path));
  if (!stats?.isFile() || stats.size > MAX_SYNC_LOG_READ_BYTES) {
    return undefined;
  }

  return safeRead(() => readFileSync(path, 'utf8'));
}

export function hydrateDoneChildTokens(
  sessionID: string,
  logDir = resolveOpenCodeLogDir(),
): SubagentTokens | undefined {
  if (!sessionID.startsWith('ses_')) return undefined;

  const nowMs = Date.now();
  pruneDoneTokenCache(nowMs);
  const cached = doneTokenCache.get(sessionID);
  if (cached?.tokens) {
    doneTokenCache.delete(sessionID);
    doneTokenCache.set(sessionID, { ...cached, checkedAtMs: nowMs });
    return cached.tokens;
  }
  if (cached && cached.attempts >= DONE_TOKEN_REHYDRATE_MAX_ATTEMPTS) {
    return undefined;
  }
  if (cached && nowMs - cached.checkedAtMs < DONE_TOKEN_REHYDRATE_THROTTLE_MS) {
    return undefined;
  }

  const files = safeRead(() =>
    readdirSync(logDir)
      .filter((file) => file.endsWith('.log'))
      .sort()
      .reverse()
      .slice(0, 8),
  );
  if (!files) return undefined;

  let tokens: SubagentTokens | undefined;
  for (const file of files) {
    const contents = readOpenCodeLogFileIfSmall(join(logDir, file));
    if (!contents || !contents.includes(sessionID)) continue;

    for (const line of contents.split('\n')) {
      if (!line.includes(sessionID)) continue;
      tokens = mergeTokens(tokens, extractTokensFromLine(line));
    }
  }

  doneTokenCache.set(sessionID, {
    attempts: (cached?.attempts ?? 0) + 1,
    checkedAtMs: nowMs,
    tokens,
  });
  pruneDoneTokenCache(nowMs);

  return tokens;
}
