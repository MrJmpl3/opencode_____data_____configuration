/** F1: returns value if finite, otherwise 0 */
export const finiteNumber = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;

/** F2: compact number formatting, no locale param */
export const formatCompactNumber = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}K`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;

  return String(n);
};

/** F3: prepend two spaces */
export const detailLine = (text: string): string => `  ${text}`;

/** F4: clamp to [0,1] and round to integer percent */
export const formatPercentRatio = (ratio: number): string =>
  `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
