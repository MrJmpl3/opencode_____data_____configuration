import { finiteNumber, hasOwn, isRecord } from './tui.ts';

export type CacheSummary = {
  hasData: boolean;
  hasWriteData: boolean;
  input: number;
  output: number;
  ratio: number;
  read: number;
  write: number;
};

const readTokens = (value: unknown): Record<string, unknown> | undefined => {
  if (!isRecord(value)) return undefined;

  const tokens = value.tokens;

  return isRecord(tokens) ? tokens : undefined;
};

const readCacheTokens = (tokens: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
  if (!tokens) return undefined;

  const cache = tokens.cache;

  return isRecord(cache) ? cache : undefined;
};

export const summarizeCacheMessages = (
  messages: readonly unknown[],
  partsForMessage: (messageId: string) => readonly unknown[] = () => [],
): CacheSummary => {
  let input = 0;
  let output = 0;
  let read = 0;
  let write = 0;
  let hasCacheData = false;
  let hasWriteData = false;

  for (const message of messages) {
    if (!isRecord(message) || message.role !== 'assistant') continue;

    const tokens = readTokens(message);
    const cache = readCacheTokens(tokens);

    input += finiteNumber(tokens?.input);
    output += finiteNumber(tokens?.output);

    if (cache && hasOwn(cache, 'read')) {
      hasCacheData = true;
      read += finiteNumber(cache.read);
    }

    if (cache && hasOwn(cache, 'write')) {
      hasCacheData = true;
      hasWriteData = true;
      write += finiteNumber(cache.write);
    }

    if (typeof message.id !== 'string') continue;

    for (const part of partsForMessage(message.id)) {
      const partCache = readCacheTokens(readTokens(part));
      if (!partCache || !hasOwn(partCache, 'write')) continue;

      hasCacheData = true;
      hasWriteData = true;
      write += finiteNumber(partCache.write);
    }
  }

  return {
    hasData: hasCacheData,
    hasWriteData,
    input,
    output,
    ratio: read + input > 0 ? read / (read + input) : 0,
    read,
    write,
  };
};
