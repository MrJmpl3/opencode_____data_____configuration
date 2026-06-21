import type { QuotaLine } from '../../domain/lines.ts';
import type { GoWindow, QuotaDisplayMode } from '../../domain/types.ts';
import { formatPercentQuota, MONTH_SECONDS } from '../../domain/format.ts';
import { detailTextLine, paceLine, windowLine } from '../../domain/lines.ts';
import { DASHBOARD_URL, USER_AGENT } from './constants.ts';
import { fetchWithTimeout, httpErrorMessage } from './http.ts';

type GoDashboard = {
  rolling: GoWindow | null;
  weekly: GoWindow | null;
  monthly: GoWindow | null;
};

export const readGoConfig = (): {
  workspaceId: string;
  authCookie: string;
} | null => {
  const workspaceId = process.env.OPENCODE_GO_WORKSPACE_ID?.trim();
  const authCookie = process.env.OPENCODE_GO_AUTH_COOKIE?.trim();
  if (workspaceId && authCookie) return { workspaceId, authCookie };
  return null;
};

const DECIMAL_PATTERN = String.raw`(-?\d+(?:\.\d+)?)`;

const windowRegexes = (key: string): { usagePercentFirst: RegExp; resetFirst: RegExp } => {
  const usagePercentFirst = new RegExp(
    String.raw`${key}:\$R\[\d+\]=\{[^}]*usagePercent:${DECIMAL_PATTERN}[^}]*resetInSec:${DECIMAL_PATTERN}[^}]*\}`,
  );
  const resetFirst = new RegExp(
    String.raw`${key}:\$R\[\d+\]=\{[^}]*resetInSec:${DECIMAL_PATTERN}[^}]*usagePercent:${DECIMAL_PATTERN}[^}]*\}`,
  );
  return { usagePercentFirst, resetFirst };
};

const parseGoWindow = (html: string, key: string): GoWindow | null => {
  const { usagePercentFirst, resetFirst } = windowRegexes(key);

  const tryMatch = (pattern: RegExp, usagePercentIndex: number, resetIndex: number): GoWindow | null => {
    const match = html.match(pattern);
    if (!match) return null;
    const usagePercent = Number(match[usagePercentIndex]);
    const resetInSec = Number(match[resetIndex]);
    if (!Number.isFinite(usagePercent) || !Number.isFinite(resetInSec)) return null;
    const used = Math.max(0, usagePercent);
    return {
      used,
      remaining: Math.max(0, 100 - used),
      resetInSec: Math.max(0, resetInSec),
    };
  };

  return tryMatch(usagePercentFirst, 1, 2) ?? tryMatch(resetFirst, 2, 1);
};

export const formatGoLines = (data: GoDashboard, displayMode: QuotaDisplayMode, fetchedAtMs: number): QuotaLine[] => {
  const lines: QuotaLine[] = [];

  const windows: readonly (readonly [string, keyof GoDashboard, number | undefined])[] = [
    ['5h', 'rolling', undefined],
    ['Wk', 'weekly', undefined],
    ['Mo', 'monthly', MONTH_SECONDS],
  ];

  for (const [name, key, paceWindowSeconds] of windows) {
    const window = data[key];
    if (!window) continue;

    lines.push(
      windowLine(
        name,
        formatPercentQuota(window.used, window.remaining, displayMode),
        window.resetInSec,
        fetchedAtMs,
        'neutral',
        window.used,
      ),
    );

    if (paceWindowSeconds !== undefined) {
      lines.push(paceLine({ usedPct: window.used, resetSec: window.resetInSec }, paceWindowSeconds, fetchedAtMs));
    }
  }

  return lines.length ? lines : [detailTextLine('No windows')];
};

export const fetchGoDashboard = async (
  workspaceId: string,
  authCookie: string,
): Promise<
  | {
      data: {
        rolling: GoWindow | null;
        weekly: GoWindow | null;
        monthly: GoWindow | null;
      };
    }
  | { error: string }
> => {
  const response = await fetchWithTimeout(DASHBOARD_URL(workspaceId), {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html',
      Cookie: `auth=${authCookie}`,
    },
  });
  if (!response.ok) return { error: httpErrorMessage('OpenCode Go', response) };

  const html = await response.text();
  const data = {
    rolling: parseGoWindow(html, 'rollingUsage'),
    weekly: parseGoWindow(html, 'weeklyUsage'),
    monthly: parseGoWindow(html, 'monthlyUsage'),
  };
  if (!data.rolling && !data.weekly && !data.monthly) {
    return { error: 'No quota data found in OpenCode Go dashboard' };
  }
  return { data };
};
