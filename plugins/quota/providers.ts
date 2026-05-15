/**
 * quota-providers — Quota data fetching for the TUI sidebar plugin.
 *
 * Consolidated here from libs/quota.js.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import os from "os";

// ─── Types ─────────────────────────────────────────────

interface GoWindow {
  used: number;
  remaining: number;
  resetInSec: number;
}

interface CopilotResult {
  text: string;
  pctRemaining?: number;
  unlimited?: boolean;
  resetTimeIso?: string;
  resetSec?: number;
}

interface OpenRouterResult {
  text: string;
  remaining?: number;
  total?: number;
  usage?: number;
}

// ─── Constants ───────────────────────────────────────────

export const FETCH_TIMEOUT_MS = 10_000;
export const DASHBOARD_URL = (id: string) =>
  `https://opencode.ai/workspace/${encodeURIComponent(id)}/go`;
export const GITHUB_API = "https://api.github.com";
export const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";
export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0";

// ─── HTTP helper ─────────────────────────────────────────

export function fetchWithTimeout(
  url: string,
  opts: RequestInit,
  ms: number = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}

// ─── OS helpers ──────────────────────────────────────────

function xdgDataHome(): string {
  return process.env.XDG_DATA_HOME || join(os.homedir(), ".local", "share");
}

function authJsonPaths(): string[] {
  return [
    join(xdgDataHome(), "opencode", "auth.json"),
    join(os.homedir(), ".config", "opencode", "auth.json"),
  ];
}

// ═══════════════════════════════════════════════════════════
// OpenCode Go
// ═══════════════════════════════════════════════════════════

export function readGoConfig(): {
  workspaceId: string;
  authCookie: string;
} | null {
  const ws = process.env.OPENCODE_GO_WORKSPACE_ID?.trim();
  const auth = process.env.OPENCODE_GO_AUTH_COOKIE?.trim();
  if (ws && auth) return { workspaceId: ws, authCookie: auth };
  return null;
}

const RE_NUM = String.raw`(-?\d+(?:\.\d+)?)`;

function windowRegexes(key: string): { pctFirst: RegExp; resetFirst: RegExp } {
  const pctFirst = new RegExp(
    String.raw`${key}:\$R\[\d+\]=\{[^}]*usagePercent:${RE_NUM}[^}]*resetInSec:${RE_NUM}[^}]*\}`,
  );
  const resetFirst = new RegExp(
    String.raw`${key}:\$R\[\d+\]=\{[^}]*resetInSec:${RE_NUM}[^}]*usagePercent:${RE_NUM}[^}]*\}`,
  );
  return { pctFirst, resetFirst };
}

/**
 * Parse a usage window from the OpenCode Go dashboard HTML.
 * Handles both field orderings (usagePercent first or resetInSec first).
 */
function parseGoWindow(html: string, key: string): GoWindow | null {
  const { pctFirst, resetFirst } = windowRegexes(key);

  const tryMatch = (
    re: RegExp,
    pctIdx: number,
    resetIdx: number,
  ): GoWindow | null => {
    const m = html.match(re);
    if (!m) return null;
    const usagePercent = Number(m[pctIdx]);
    const resetInSec = Number(m[resetIdx]);
    if (!Number.isFinite(usagePercent) || !Number.isFinite(resetInSec))
      return null;
    const used = Math.max(0, usagePercent);
    return {
      used,
      remaining: Math.max(0, 100 - used),
      resetInSec: Math.max(0, resetInSec),
    };
  };

  return tryMatch(pctFirst, 1, 2) ?? tryMatch(resetFirst, 2, 1);
}

/**
 * Fetch OpenCode Go dashboard and parse usage windows.
 */
export async function fetchGoDashboard(
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
> {
  const res = await fetchWithTimeout(DASHBOARD_URL(workspaceId), {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html",
      Cookie: `auth=${authCookie}`,
    },
  });
  if (!res.ok) return { error: `OpenCode Go HTTP ${res.status}` };

  const html = await res.text();
  const data = {
    rolling: parseGoWindow(html, "rollingUsage"),
    weekly: parseGoWindow(html, "weeklyUsage"),
    monthly: parseGoWindow(html, "monthlyUsage"),
  };
  if (!data.rolling && !data.weekly && !data.monthly) {
    return { error: "No quota data found in OpenCode Go dashboard" };
  }
  return { data };
}

// ═══════════════════════════════════════════════════════════
// GitHub Copilot
// ═══════════════════════════════════════════════════════════

/**
 * Read Copilot OAuth token from OpenCode's auth.json.
 */
export function readCopilotToken(): string | null {
  for (const path of authJsonPaths()) {
    if (!existsSync(path)) continue;
    try {
      const auth: Record<string, unknown> = JSON.parse(
        readFileSync(path, "utf-8"),
      );
      for (const key of [
        "github-copilot",
        "copilot",
        "copilot-chat",
        "github-copilot-chat",
      ] as const) {
        const entry = auth[key];
        if (
          entry &&
          typeof entry === "object" &&
          (entry as Record<string, unknown>).type === "oauth"
        ) {
          const access = (entry as Record<string, unknown>).access;
          if (typeof access === "string") return access;
        }
      }
    } catch {
      /* try next path */
    }
  }
  return null;
}

/**
 * Navigate nested objects via path array.
 */
function getNested(obj: unknown, path: readonly string[]): unknown {
  let v: unknown = obj;
  for (const k of path) {
    if (v == null || typeof v !== "object") return undefined;
    v = (v as Record<string, unknown>)[k];
  }
  return v;
}

function findNumber(
  data: unknown,
  paths: readonly (readonly string[])[],
): number | undefined {
  for (const p of paths) {
    const v = getNested(data, p);
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

function findBoolean(
  data: unknown,
  paths: readonly (readonly string[])[],
): boolean | undefined {
  for (const p of paths) {
    const v = getNested(data, p);
    if (typeof v === "boolean") return v;
  }
  return undefined;
}

function findString(
  data: unknown,
  paths: readonly (readonly string[])[],
): string | undefined {
  for (const p of paths) {
    const v = getNested(data, p);
    if (typeof v === "string") return v;
  }
  return undefined;
}

const COPILOT_TOTAL_PATHS = [
  ["quota", "limit"],
  ["quota", "total"],
  ["monthly_quota", "limit"],
  ["monthly_quota", "total"],
  ["monthly_premium_requests", "limit"],
  ["monthly_premium_requests", "total"],
  ["premium_requests", "limit"],
  ["premium_requests", "total"],
  ["quota_snapshots", "premium_interactions", "entitlement"],
  ["limit"],
  ["total"],
  ["quota_limit"],
  ["monthly_limit"],
  ["included_premium_requests"],
  ["monthly_quotas", "chat"],
  ["monthly_quotas", "completions"],
] as const;

const COPILOT_USED_PATHS = [
  ["quota", "used"],
  ["monthly_quota", "used"],
  ["monthly_premium_requests", "used"],
  ["premium_requests", "used"],
  ["used"],
  ["quota_used"],
  ["monthly_used"],
  ["premium_requests_used"],
] as const;

const COPILOT_REMAINING_PATHS = [
  ["quota", "remaining"],
  ["monthly_quota", "remaining"],
  ["monthly_premium_requests", "remaining"],
  ["premium_requests", "remaining"],
  ["quota_snapshots", "premium_interactions", "remaining"],
  ["quota_snapshots", "premium_interactions", "quota_remaining"],
  ["remaining"],
  ["quota_remaining"],
  ["monthly_remaining"],
  ["premium_requests_remaining"],
  ["limited_user_quotas", "chat"],
  ["limited_user_quotas", "completions"],
] as const;

const COPILOT_RESET_PATHS = [
  ["quota", "reset_at"],
  ["monthly_quota", "reset_at"],
  ["monthly_premium_requests", "reset_at"],
  ["premium_requests", "reset_at"],
  ["reset_at"],
  ["quota_reset_date_utc"],
  ["quota_reset_date"],
  ["limited_user_reset_date"],
] as const;

const COPILOT_UNLIMITED_PATHS = [
  ["quota", "unlimited"],
  ["monthly_quota", "unlimited"],
  ["monthly_premium_requests", "unlimited"],
  ["premium_requests", "unlimited"],
  ["quota_snapshots", "premium_interactions", "unlimited"],
  ["unlimited"],
] as const;

const COPILOT_TIER_PATHS = [
  ["plan", "type"],
  ["plan", "name"],
  ["plan"],
  ["copilot_plan"],
  ["subscription_plan"],
  ["sku"],
] as const;

const COPILOT_TIER_LIMITS: Record<string, number> = {
  free: 50,
  pro: 300,
  "pro+": 1500,
  business: 300,
  enterprise: 1000,
};

/**
 * Fetch Copilot personal quota from /copilot_internal/user.
 */
export async function fetchCopilotQuota(): Promise<
  CopilotResult | null | { error: string }
> {
  const token = readCopilotToken();
  if (!token) return null;

  const res = await fetchWithTimeout(`${GITHUB_API}/copilot_internal/user`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": USER_AGENT,
    },
  });
  if (!res.ok) return { error: `Copilot API HTTP ${res.status}` };

  const data: unknown = await res.json();

  let total = findNumber(data, COPILOT_TOTAL_PATHS);
  let used = findNumber(data, COPILOT_USED_PATHS);
  const remaining = findNumber(data, COPILOT_REMAINING_PATHS);
  const unlimited = findBoolean(data, COPILOT_UNLIMITED_PATHS) === true;
  const tier = findString(data, COPILOT_TIER_PATHS);

  if (total === undefined && used !== undefined && remaining !== undefined)
    total = used + remaining;
  if (used === undefined && total !== undefined && remaining !== undefined)
    used = Math.max(0, total - remaining);
  if (total === undefined && tier)
    total = COPILOT_TIER_LIMITS[tier.toLowerCase()] ?? COPILOT_TIER_LIMITS.pro;

  if (unlimited) return { text: "Unlimited", unlimited: true };

  if (total === undefined || total <= 0 || used === undefined || used < 0) {
    return { error: "Could not extract Copilot quota data" };
  }

  // Reset time
  const resetAt = findNumber(data, COPILOT_RESET_PATHS);
  const resetTimeIso = resetAt
    ? new Date(resetAt).toISOString()
    : new Date(
        Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1),
      ).toISOString();
  const resetSec = Math.max(
    0,
    Math.floor((new Date(resetTimeIso).getTime() - Date.now()) / 1000),
  );

  const remainingCount = Math.max(0, total - used);
  return {
    text: `${remainingCount}/${total}`,
    pctRemaining: Math.round((remainingCount / total) * 100),
    resetTimeIso,
    resetSec,
  };
}

// ═══════════════════════════════════════════════════════════
// OpenRouter
// ═══════════════════════════════════════════════════════════

/**
 * Read OpenRouter API key from env or config file.
 */
export function readOpenRouterKey(): string | null {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (key) return key;

  // Fallback: config file
  try {
    const path = join(
      os.homedir(),
      ".config",
      "opencode",
      "openrouter-auth.json",
    );
    if (existsSync(path)) {
      const raw: Record<string, unknown> = JSON.parse(
        readFileSync(path, "utf-8"),
      );
      for (const k of [
        "apiKey",
        "api_key",
        "token",
        "openrouterApiKey",
      ] as const) {
        if (raw[k] && typeof raw[k] === "string") return raw[k].trim();
      }
    }
  } catch {}
  return null;
}

/**
 * Fetch OpenRouter credit balance.
 */
export async function fetchOpenRouterQuota(): Promise<
  OpenRouterResult | null | { error: string }
> {
  const key = readOpenRouterKey();
  if (!key) return null;

  const res = await fetchWithTimeout(OPENROUTER_CREDITS_URL, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { error: `OpenRouter HTTP ${res.status}: ${text.slice(0, 120)}` };
  }

  const body: unknown = await res.json();
  const d = (body as Record<string, unknown>)?.data ?? body;

  const totalCredits =
    typeof (d as Record<string, unknown>).total_credits === "number" &&
    Number.isFinite((d as Record<string, unknown>).total_credits)
      ? ((d as Record<string, unknown>).total_credits as number)
      : null;
  const totalUsage =
    typeof (d as Record<string, unknown>).total_usage === "number" &&
    Number.isFinite((d as Record<string, unknown>).total_usage)
      ? ((d as Record<string, unknown>).total_usage as number)
      : null;

  if (totalCredits !== null && totalCredits > 0) {
    const remaining = Math.max(0, totalCredits - (totalUsage ?? 0));
    return { text: `$${remaining.toFixed(2)}`, remaining, total: totalCredits };
  }

  if (totalUsage !== null) {
    return {
      text: `$${totalUsage.toFixed(4)} used (no limit)`,
      usage: totalUsage,
    };
  }

  return { error: "OpenRouter did not return expected credit data" };
}

// ═══════════════════════════════════════════════════════════
// Format helpers
// ═══════════════════════════════════════════════════════════

const BAR_WIDTH = 14;

/**
 * Render a progress bar as a string.
 * @param pct - Percentage to fill (0-100).
 * @param w - Width in characters.
 */
export function progressBar(pct: number, w: number = BAR_WIDTH): string {
  const filled = Math.round((Math.min(pct, 100) / 100) * w);
  return "█".repeat(filled) + "░".repeat(w - filled);
}

/**
 * Format seconds as human-readable duration.
 */
export function fmtDuration(sec?: number): string {
  if (!sec || sec <= 0) return "";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/**
 * Format an ISO date string as relative time remaining.
 */
export function fmtDurationIso(iso: string): string {
  if (!iso) return "";
  const diff = Math.max(
    0,
    Math.floor((new Date(iso).getTime() - Date.now()) / 1000),
  );
  return fmtDuration(diff);
}
