const parseBackoffDelayMs = (message: string, pattern: RegExp): number => {
  const match = message.match(pattern);
  if (!match) return 0;
  const rawValue = match[1].trim();
  const numericValue = rawValue.match(/^\d+(?:\.\d+)?/)?.[0];
  const seconds = numericValue ? Number(numericValue) : Number.NaN;
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;

  const retryAtMs = Date.parse(rawValue);
  if (!Number.isNaN(retryAtMs)) return Math.max(0, retryAtMs - Date.now());

  return 0;
};

const parseBackoffResetMs = (message: string, pattern: RegExp): number => {
  const match = message.match(pattern);
  if (!match) return 0;
  const rawValue = match[1].trim();
  const numericValue = rawValue.match(/^\d+(?:\.\d+)?/)?.[0];
  const resetValue = numericValue ? Number(numericValue) : Number.NaN;
  if (Number.isFinite(resetValue) && resetValue > 0) {
    const resetAtMs = resetValue > 1_000_000_000 ? resetValue * 1000 : Date.now() + resetValue * 1000;
    return Math.max(0, resetAtMs - Date.now());
  }

  const retryAtMs = Date.parse(rawValue);
  if (!Number.isNaN(retryAtMs)) return Math.max(0, retryAtMs - Date.now());

  return 0;
};

export const isQuotaRateLimitError = (message: string): boolean => {
  return /\b429\b|rate.?limit|too many requests|temporar(?:y|ily)|secondary rate/i.test(message);
};

export const retryAfterMsFromMessage = (message: string): number => {
  const retryAfterMs = parseBackoffDelayMs(message, /retry[- ]after[:=]?\s*([^;\n]+)/i);
  if (retryAfterMs > 0) return retryAfterMs;

  return parseBackoffResetMs(message, /rate[- ]limit[- ]reset[:=]?\s*([^;\n]+)/i);
};
