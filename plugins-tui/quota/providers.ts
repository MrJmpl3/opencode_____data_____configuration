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
  used?: number;
  remaining?: number;
  total?: number;
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

interface OpenAIWindow {
  usedPct: number;
  resetSec: number;
}

interface OpenAIResult {
  planType?: string;
  hourly?: OpenAIWindow;
  weekly?: OpenAIWindow;
  codeReview?: OpenAIWindow;
  credits?: string;
}

// ─── Constants ───────────────────────────────────────────

export const FETCH_TIMEOUT_MS = 10_000;
// 10s. Prevents the TUI sidebar from freezing on slow or dead endpoints.
export const DASHBOARD_URL = (id: string) =>
  `https://opencode.ai/workspace/${encodeURIComponent(id)}/go`;
export const GITHUB_API = "https://api.github.com";
export const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";
export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0";

// ─── HTTP helper ─────────────────────────────────────────

// --- Fetch timeout ---
// AbortController wrapper that bails after 10s. Without this, a hanging
// fetch would block the TUI render loop entirely.

export const fetchWithTimeout = (
  url: string,
  opts: RequestInit,
  ms: number = FETCH_TIMEOUT_MS,
): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
};

// ─── OS helpers ──────────────────────────────────────────

const xdgDataHome = (): string => {
  return process.env.XDG_DATA_HOME || join(os.homedir(), ".local", "share");
};

const authJsonPaths = (): string[] => {
  return [
    join(xdgDataHome(), "opencode", "auth.json"),
    join(os.homedir(), ".config", "opencode", "auth.json"),
  ];
};

const readAuthJson = (): Record<string, unknown> | null => {
  for (const path of authJsonPaths()) {
    if (!existsSync(path)) continue;
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    } catch {
      continue;
    }
  }
  return null;
};

const readOauthAccessToken = (keys: readonly string[]): string | null => {
  const auth = readAuthJson();
  if (!auth) return null;
  for (const key of keys) {
    const entry = auth[key];
    if (!entry || typeof entry !== "object") continue;
    const oauthEntry = entry as Record<string, unknown>;
    if (oauthEntry.type !== "oauth") continue;
    const access = oauthEntry.access;
    if (typeof access === "string" && access.trim()) return access.trim();
  }
  return null;
};

const readOauthAccountId = (keys: readonly string[]): string | null => {
  const auth = readAuthJson();
  if (!auth) return null;
  for (const key of keys) {
    const entry = auth[key];
    if (!entry || typeof entry !== "object") continue;
    const oauthEntry = entry as Record<string, unknown>;
    if (oauthEntry.type !== "oauth") continue;
    const accountId = oauthEntry.account_id ?? oauthEntry.accountId;
    if (typeof accountId === "string" && accountId.trim())
      return accountId.trim();
  }
  return null;
};

const parseJwtPayload = (token: string): Record<string, unknown> | null => {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = Buffer.from(parts[1], "base64url").toString("utf-8");
    const parsed: unknown = JSON.parse(payload);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
};

const readOpenAIAccountId = (token: string): string | null => {
  const fromAuth = readOauthAccountId(["openai", "chatgpt", "codex"]);
  if (fromAuth) return fromAuth;
  const payload = parseJwtPayload(token);
  if (!payload) return null;
  const jwtAccountId = payload.chatgpt_account_id;
  if (typeof jwtAccountId === "string" && jwtAccountId.trim()) {
    return jwtAccountId.trim();
  }
  return null;
};

// ═══════════════════════════════════════════════════════════
// OpenCode Go
// ═══════════════════════════════════════════════════════════

// --- HTML scraping ---
// OpenCode Go has no public API. We scrape the HTML dashboard and extract
// usage windows from inlined $R[] JavaScript objects using regex.

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

// --- Regex orderings ---
// The $R[] objects don't guarantee field order. We generate two patterns
// (usagePercent first, resetInSec first) and try both when parsing.
const windowRegexes = (
  key: string,
): { pctFirst: RegExp; resetFirst: RegExp } => {
  const pctFirst = new RegExp(
    String.raw`${key}:\$R\[\d+\]=\{[^}]*usagePercent:${RE_NUM}[^}]*resetInSec:${RE_NUM}[^}]*\}`,
  );
  const resetFirst = new RegExp(
    String.raw`${key}:\$R\[\d+\]=\{[^}]*resetInSec:${RE_NUM}[^}]*usagePercent:${RE_NUM}[^}]*\}`,
  );
  return { pctFirst, resetFirst };
};

/**
 * Parse a usage window from the OpenCode Go dashboard HTML.
 * Handles both field orderings (usagePercent first or resetInSec first).
 */
const parseGoWindow = (html: string, key: string): GoWindow | null => {
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
};

/**
 * Fetch OpenCode Go dashboard and parse usage windows.
 */
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
};

// ═══════════════════════════════════════════════════════════
// GitHub Copilot
// ═══════════════════════════════════════════════════════════

// --- Copilot token ---
// Reads an OAuth token from auth.json. Multiple keys are checked because
// the auth plugin has changed key names across versions: older configs
// stored it under "copilot-chat", newer ones under "github-copilot" or
// "github-copilot-chat".

/**
 * Read Copilot OAuth token from OpenCode's auth.json.
 */
export const readCopilotToken = (): string | null => {
  return readOauthAccessToken([
    "github-copilot",
    "copilot",
    "copilot-chat",
    "github-copilot-chat",
  ]);
};

/**
 * Navigate nested objects via path array.
 */
const getNested = (obj: unknown, path: readonly string[]): unknown => {
  let v: unknown = obj;
  for (const k of path) {
    if (v == null || typeof v !== "object") return undefined;
    v = (v as Record<string, unknown>)[k];
  }
  return v;
};

const findNumber = (
  data: unknown,
  paths: readonly (readonly string[])[],
): number | undefined => {
  for (const p of paths) {
    const v = getNested(data, p);
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
};

const findBoolean = (
  data: unknown,
  paths: readonly (readonly string[])[],
): boolean | undefined => {
  for (const p of paths) {
    const v = getNested(data, p);
    if (typeof v === "boolean") return v;
  }
  return undefined;
};

const findString = (
  data: unknown,
  paths: readonly (readonly string[])[],
): string | undefined => {
  for (const p of paths) {
    const v = getNested(data, p);
    if (typeof v === "string") return v;
  }
  return undefined;
};

// --- Path fallbacks ---
// The Copilot API returns different response shapes depending on the API
// version, user plan, and region. Each path array tries every known key
// location and returns the first match. This keeps the fetcher working
// across backend changes without requiring code updates.

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
export const fetchCopilotQuota = async (): Promise<
  CopilotResult | null | { error: string }
> => {
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
    used,
    remaining: remainingCount,
    total,
    pctRemaining: Math.round((remainingCount / total) * 100),
    resetTimeIso,
    resetSec,
  };
};

// ═══════════════════════════════════════════════════════════
// OpenRouter
// ═══════════════════════════════════════════════════════════

// --- API key sourcing ---
// First checks OPENROUTER_API_KEY env var. Falls back to a local config
// file because some setups store provider keys in JSON files under
// ~/.config/opencode/ rather than using environment variables.

/**
 * Read OpenRouter API key from env or config file.
 */
export const readOpenRouterKey = (): string | null => {
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
};

/**
 * Fetch OpenRouter credit balance.
 */
export const fetchOpenRouterQuota = async (): Promise<
  OpenRouterResult | null | { error: string }
> => {
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
    const usage = totalUsage ?? 0;
    const remaining = Math.max(0, totalCredits - (totalUsage ?? 0));
    return {
      text: `$${remaining.toFixed(2)}`,
      remaining,
      total: totalCredits,
      usage,
    };
  }

  if (totalUsage !== null) {
    return {
      text: `$${totalUsage.toFixed(4)} used (no limit)`,
      usage: totalUsage,
    };
  }

  return { error: "OpenRouter did not return expected credit data" };
};

// ═══════════════════════════════════════════════════════════
// OpenAI
// ═══════════════════════════════════════════════════════════

const OPENAI_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

export const readOpenAIToken = (): string | null => {
  return readOauthAccessToken(["openai", "chatgpt", "codex", "opencode"]);
};

const readNumberField = (
  data: Record<string, unknown>,
  key: string,
): number | undefined => {
  const value = data[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
};

const readStringField = (
  data: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = data[key];
  return typeof value === "string" && value.trim() ? value : undefined;
};

const parseOpenAIWindow = (value: unknown): OpenAIWindow | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const usedPct = readNumberField(record, "used_percent");
  if (usedPct === undefined) return undefined;

  const resetAfterSeconds = readNumberField(record, "reset_after_seconds");
  if (resetAfterSeconds !== undefined) {
    return {
      usedPct: Math.max(0, Math.min(100, usedPct)),
      resetSec: Math.max(0, Math.floor(resetAfterSeconds)),
    };
  }

  const resetAt = readStringField(record, "reset_at");
  if (!resetAt) return undefined;
  const resetSec = Math.max(
    0,
    Math.floor((new Date(resetAt).getTime() - Date.now()) / 1000),
  );

  return {
    usedPct: Math.max(0, Math.min(100, usedPct)),
    resetSec,
  };
};

export const fetchOpenAIQuota = async (): Promise<
  OpenAIResult | null | { error: string }
> => {
  const token = readOpenAIToken();
  if (!token) return null;

  const accountId = readOpenAIAccountId(token);
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "OpenCode-Quota-Toast/1.0",
  };
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;

  const res = await fetchWithTimeout(OPENAI_USAGE_URL, { headers });
  if (!res.ok) {
    const text = await res.text().catch((error: unknown) => {
      if (error instanceof Error) return error.message;
      return String(error);
    });
    return { error: `OpenAI HTTP ${res.status}: ${text.slice(0, 120)}` };
  }

  const body: unknown = await res.json();
  if (!body || typeof body !== "object") {
    return { error: "OpenAI did not return a valid usage payload" };
  }

  const data = body as Record<string, unknown>;
  const rateLimit =
    data.rate_limit && typeof data.rate_limit === "object"
      ? (data.rate_limit as Record<string, unknown>)
      : undefined;
  const codeReviewRateLimit =
    data.code_review_rate_limit &&
    typeof data.code_review_rate_limit === "object"
      ? (data.code_review_rate_limit as Record<string, unknown>)
      : undefined;
  const credits =
    data.credits && typeof data.credits === "object"
      ? (data.credits as Record<string, unknown>)
      : undefined;

  const result: OpenAIResult = {
    planType: readStringField(data, "plan_type"),
    hourly: parseOpenAIWindow(rateLimit?.primary_window),
    weekly: parseOpenAIWindow(rateLimit?.secondary_window),
    codeReview: parseOpenAIWindow(codeReviewRateLimit?.primary_window),
  };

  if (credits) {
    const unlimited = credits.unlimited === true;
    const hasCredits = credits.has_credits === true || unlimited;
    const balance =
      typeof credits.balance === "number" && Number.isFinite(credits.balance)
        ? credits.balance
        : undefined;
    if (unlimited) {
      result.credits = "Unlimited";
    } else if (hasCredits && balance !== undefined) {
      result.credits = `$${balance.toFixed(2)}`;
    }
  }

  if (
    !result.hourly &&
    !result.weekly &&
    !result.codeReview &&
    !result.credits &&
    !result.planType
  ) {
    return { error: "OpenAI did not return expected quota data" };
  }

  return result;
};

// ═══════════════════════════════════════════════════════════
// Format helpers
// ═══════════════════════════════════════════════════════════

// --- Progress bar ---
// Renders a visual bar for the TUI. Not used by the current quota index
// view, but available for callers who want richer display formatting.

const BAR_WIDTH = 14;

/**
 * Render a progress bar as a string.
 * @param pct - Percentage to fill (0-100).
 * @param w - Width in characters.
 */
export const progressBar = (pct: number, w: number = BAR_WIDTH): string => {
  const filled = Math.round((Math.min(pct, 100) / 100) * w);
  return "█".repeat(filled) + "░".repeat(w - filled);
};

/**
 * Format seconds as human-readable duration.
 */
export const fmtDuration = (sec?: number): string => {
  if (!sec || sec <= 0) return "";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
};

/**
 * Format an ISO date string as relative time remaining.
 */
export const fmtDurationIso = (iso: string): string => {
  if (!iso) return "";
  const diff = Math.max(
    0,
    Math.floor((new Date(iso).getTime() - Date.now()) / 1000),
  );
  return fmtDuration(diff);
};
