import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

import { hasCompleteUsageMetrics } from '../domain/tokens.ts';
import type { SubagentTokens } from '../domain/types.ts';
import { isRecord, toFiniteNumber } from '../shared/coercion.ts';

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

const pruneDoneTokenCache = (nowMs: number): void => {
  for (const [sessionId, entry] of doneTokenCache) {
    if (nowMs - entry.checkedAtMs <= DONE_TOKEN_CACHE_TTL_MS) continue;
    doneTokenCache.delete(sessionId);
  }

  while (doneTokenCache.size > DONE_TOKEN_CACHE_MAX_ENTRIES) {
    const oldestSessionId = doneTokenCache.keys().next().value;
    if (typeof oldestSessionId !== 'string') break;
    doneTokenCache.delete(oldestSessionId);
  }
};

const safeRead = <T>(reader: () => T): T | undefined => {
  try {
    return reader();
  } catch {
    return undefined;
  }
};

const normalizePercent = (value: number): number => {
  if (value > 0 && value <= 1) {
    return value * 100;
  }

  return value;
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

const hasUsableTokens = (tokens: SubagentTokens | undefined): boolean => {
  return Boolean(
    typeof tokens?.input === 'number' ||
    typeof tokens?.output === 'number' ||
    typeof tokens?.total === 'number' ||
    typeof tokens?.contextPercent === 'number',
  );
};

const sanitizeTokens = (input: unknown): SubagentTokens | undefined => {
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
};

const extractTokenHints = (input: unknown): SubagentTokens | undefined => {
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
};

const extractJsonPayloads = (line: string): unknown[] => {
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
};

const resolveOpenCodeDataDir = (): string => {
  const baseDir = process.env.XDG_DATA_HOME ?? join(os.homedir(), '.local', 'share');
  return join(baseDir, 'opencode');
};

const resolveOpenCodeLogDir = (): string => {
  return join(resolveOpenCodeDataDir(), 'log');
};

const extractTokensFromLine = (line: string): SubagentTokens | undefined => {
  let tokens: SubagentTokens | undefined;

  for (const payload of extractJsonPayloads(line)) {
    tokens = mergeTokens(tokens, extractTokenHints(payload));
  }

  return hasUsableTokens(tokens) ? tokens : undefined;
};

export const readOpenCodeLogFileIfSmall = (path: string): string | undefined => {
  const stats = safeRead(() => statSync(path));
  if (!stats?.isFile() || stats.size > MAX_SYNC_LOG_READ_BYTES) {
    return undefined;
  }

  return safeRead(() => readFileSync(path, 'utf8'));
};

export const hydrateDoneChildTokens = (
  sessionId: string,
  logDir = resolveOpenCodeLogDir(),
): SubagentTokens | undefined => {
  if (!sessionId.startsWith('ses_')) return undefined;

  const nowMs = Date.now();
  pruneDoneTokenCache(nowMs);
  const cached = doneTokenCache.get(sessionId);
  if (cached?.tokens && hasCompleteUsageMetrics(cached.tokens)) {
    doneTokenCache.delete(sessionId);
    doneTokenCache.set(sessionId, { ...cached, checkedAtMs: nowMs });
    return cached.tokens;
  }
  if (cached && cached.attempts >= DONE_TOKEN_REHYDRATE_MAX_ATTEMPTS && !cached.tokens) {
    return undefined;
  }
  if (cached && nowMs - cached.checkedAtMs < DONE_TOKEN_REHYDRATE_THROTTLE_MS) {
    return cached.tokens;
  }

  const files = safeRead(() =>
    readdirSync(logDir)
      .filter((file) => file.endsWith('.log'))
      .sort()
      .reverse()
      .slice(0, 8),
  );
  if (!files) return undefined;

  let tokens = cached?.tokens;
  for (const file of files) {
    const contents = readOpenCodeLogFileIfSmall(join(logDir, file));
    if (!contents || !contents.includes(sessionId)) continue;

    for (const line of contents.split('\n')) {
      if (!line.includes(sessionId)) continue;
      tokens = mergeTokens(tokens, extractTokensFromLine(line));
    }
  }

  doneTokenCache.set(sessionId, {
    attempts: (cached?.attempts ?? 0) + 1,
    checkedAtMs: nowMs,
    tokens,
  });
  pruneDoneTokenCache(nowMs);

  return tokens;
};
