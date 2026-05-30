import { DASHBOARD_URL, USER_AGENT } from './constants.js';
import { fetchWithTimeout, httpErrorMessage } from './http.js';
import type { GoWindow } from './types.js';

export const readGoConfig = (): {
  workspaceId: string;
  authCookie: string;
} | null => {
  const ws = process.env.OPENCODE_GO_WORKSPACE_ID?.trim();
  const auth = process.env.OPENCODE_GO_AUTH_COOKIE?.trim();
  if (ws && auth) return { workspaceId: ws, authCookie: auth };
  return null;
};

const RE_NUM = String.raw`(-?\d+(?:\.\d+)?)`;

const windowRegexes = (key: string): { pctFirst: RegExp; resetFirst: RegExp } => {
  const pctFirst = new RegExp(
    String.raw`${key}:\$R\[\d+\]=\{[^}]*usagePercent:${RE_NUM}[^}]*resetInSec:${RE_NUM}[^}]*\}`,
  );
  const resetFirst = new RegExp(
    String.raw`${key}:\$R\[\d+\]=\{[^}]*resetInSec:${RE_NUM}[^}]*usagePercent:${RE_NUM}[^}]*\}`,
  );
  return { pctFirst, resetFirst };
};

// OpenCode Go has no public API, so the dashboard HTML is parsed from inlined $R[] objects.
const parseGoWindow = (html: string, key: string): GoWindow | null => {
  const { pctFirst, resetFirst } = windowRegexes(key);

  const tryMatch = (re: RegExp, pctIdx: number, resetIdx: number): GoWindow | null => {
    const m = html.match(re);
    if (!m) return null;
    const usagePercent = Number(m[pctIdx]);
    const resetInSec = Number(m[resetIdx]);
    if (!Number.isFinite(usagePercent) || !Number.isFinite(resetInSec)) return null;
    const used = Math.max(0, usagePercent);
    return {
      used,
      remaining: Math.max(0, 100 - used),
      resetInSec: Math.max(0, resetInSec),
    };
  };

  return tryMatch(pctFirst, 1, 2) ?? tryMatch(resetFirst, 2, 1);
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
  const res = await fetchWithTimeout(DASHBOARD_URL(workspaceId), {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html',
      Cookie: `auth=${authCookie}`,
    },
  });
  if (!res.ok) return { error: httpErrorMessage('OpenCode Go', res) };

  const html = await res.text();
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
