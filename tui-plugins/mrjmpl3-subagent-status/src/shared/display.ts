const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim();

export const conciseText = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;

  const text = normalizeWhitespace(value);
  if (!text) return undefined;

  return text.length > 180 ? `${text.slice(0, 179)}…` : text;
};

export const normalizeDisplayText = (value: string): string => normalizeWhitespace(value).toLowerCase();

export const sameDisplayText = (left?: string, right?: string): boolean => {
  if (!left || !right) return false;
  return normalizeDisplayText(left) === normalizeDisplayText(right);
};
