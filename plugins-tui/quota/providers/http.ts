import { FETCH_TIMEOUT_MS } from './constants.js';

export const fetchWithTimeout = async (
  url: string,
  opts: RequestInit,
  ms: number = FETCH_TIMEOUT_MS,
): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);

  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Request to ${url} timed out after ${ms}ms`);
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
};

export const httpErrorMessage = (label: string, res: Response, body?: string): string => {
  const details = [`${label} HTTP ${res.status}`];
  const retryAfter = res.headers.get('retry-after')?.trim();
  const rateLimitReset = res.headers.get('x-ratelimit-reset')?.trim() || res.headers.get('ratelimit-reset')?.trim();

  if (retryAfter) details.push(`retry-after=${sanitizeErrorText(retryAfter)}`);
  if (rateLimitReset) details.push(`rate-limit-reset=${sanitizeErrorText(rateLimitReset)}`);

  const preview = describeResponseBody(body);
  if (preview) details.push(preview);

  return details.join('; ');
};

const MAX_ERROR_PREVIEW_CHARS = 120;
const ANSI_ESCAPE_SEQUENCE_RE = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const HTML_TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const HTML_MARKUP_RE = /<(?:!doctype\s+html|\/?[a-z][\w:-]*(?:\s[^<>]*?)?)>/i;

const sanitizeErrorText = (value: string): string => {
  return value
    .replace(ANSI_ESCAPE_SEQUENCE_RE, '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

const stripHtmlTags = (value: string): string => {
  return value.replace(/<[^>]*>/g, ' ');
};

const previewErrorText = (value: string): string => {
  const sanitized = sanitizeErrorText(value);
  if (sanitized.length <= MAX_ERROR_PREVIEW_CHARS) return sanitized;
  return `${sanitized.slice(0, MAX_ERROR_PREVIEW_CHARS - 1).trimEnd()}…`;
};

const describeResponseBody = (body?: string): string | undefined => {
  if (!body) return undefined;

  const trimmed = body.trim();
  if (!trimmed) return undefined;

  const sanitized = sanitizeErrorText(trimmed);
  if (!sanitized) return undefined;

  if (HTML_MARKUP_RE.test(sanitized)) {
    const title = sanitized.match(HTML_TITLE_RE)?.[1] ?? trimmed.match(HTML_TITLE_RE)?.[1];
    const cleanTitle = title ? previewErrorText(stripHtmlTags(title)) : '';
    return cleanTitle ? `HTML response: ${cleanTitle}` : 'HTML response';
  }

  const preview = previewErrorText(sanitized);
  return preview || undefined;
};

export const readJsonResponse = async (
  label: string,
  res: Response,
): Promise<{ data: unknown } | { error: string }> => {
  let text: string;

  try {
    text = await res.text();
  } catch {
    return { error: `${label} returned an unreadable JSON response` };
  }

  const normalized = text.replace(/^\uFEFF/, '');

  try {
    return { data: JSON.parse(normalized) as unknown };
  } catch {
    const preview = describeResponseBody(normalized);
    return {
      error: preview ? `${label} returned invalid JSON · ${preview}` : `${label} returned invalid JSON`,
    };
  }
};
