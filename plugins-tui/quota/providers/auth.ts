import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import os from 'os';

const xdgDataHome = (): string => {
  return process.env.XDG_DATA_HOME || join(os.homedir(), '.local', 'share');
};

const authJsonPaths = (): string[] => {
  return [join(xdgDataHome(), 'opencode', 'auth.json'), join(os.homedir(), '.config', 'opencode', 'auth.json')];
};

const readAuthJson = (): Record<string, unknown> | null => {
  for (const path of authJsonPaths()) {
    if (!existsSync(path)) continue;
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    } catch {
      continue;
    }
  }
  return null;
};

export const readOauthAccessToken = (keys: readonly string[]): string | null => {
  const auth = readAuthJson();
  if (!auth) return null;
  for (const key of keys) {
    const entry = auth[key];
    if (!entry || typeof entry !== 'object') continue;
    const oauthEntry = entry as Record<string, unknown>;
    if (oauthEntry.type !== 'oauth') continue;
    const access = oauthEntry.access;
    if (typeof access === 'string' && access.trim()) return access.trim();
  }
  return null;
};

const readOauthAccountId = (keys: readonly string[]): string | null => {
  const auth = readAuthJson();
  if (!auth) return null;
  for (const key of keys) {
    const entry = auth[key];
    if (!entry || typeof entry !== 'object') continue;
    const oauthEntry = entry as Record<string, unknown>;
    if (oauthEntry.type !== 'oauth') continue;
    const accountId = oauthEntry.account_id ?? oauthEntry.accountId;
    if (typeof accountId === 'string' && accountId.trim()) return accountId.trim();
  }
  return null;
};

const parseJwtPayload = (token: string): Record<string, unknown> | null => {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
    const parsed: unknown = JSON.parse(payload);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
};

export const readOpenAIAccountId = (token: string): string | null => {
  const fromAuth = readOauthAccountId(['openai', 'chatgpt', 'codex']);
  if (fromAuth) return fromAuth;
  const payload = parseJwtPayload(token);
  if (!payload) return null;
  const jwtAccountId = payload.chatgpt_account_id;
  if (typeof jwtAccountId === 'string' && jwtAccountId.trim()) {
    return jwtAccountId.trim();
  }
  return null;
};
