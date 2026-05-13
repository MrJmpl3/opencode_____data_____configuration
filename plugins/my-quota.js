// my-quota — Plugin de cuota para OpenCode
// Basado en: https://github.com/slkiser/opencode-quota
//
// Providers:
//   - OpenCode Go: scrapea dashboard.opencode.ai
//   - GitHub Copilot: via OAuth token de auth.json o PAT

import { readFileSync, existsSync } from "fs";
import { join } from "path";

const GITHUB_API = "https://api.github.com";
const DASHBOARD_URL = (id) =>
  `https://opencode.ai/workspace/${encodeURIComponent(id)}/go`;
const FETCH_TIMEOUT_MS = 10_000;
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0";

// ─── Helpers ─────────────────────────────────────────────

function xdgDataHome() {
  return process.env.XDG_DATA_HOME || join(require("os").homedir(), ".local", "share");
}

function fetchWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// ─── OpenCode Go ─────────────────────────────────────────

function readGoConfig() {
  const ws = process.env.OPENCODE_GO_WORKSPACE_ID?.trim();
  const auth = process.env.OPENCODE_GO_AUTH_COOKIE?.trim();
  if (ws && auth) return { workspaceId: ws, authCookie: auth };
  return null;
}

const RE_NUM = String.raw`(-?\d+(?:\.\d+)?)`;

function reBothOrders(key) {
  const pctFirst = new RegExp(
    String.raw`${key}:\$R\[\d+\]=\{[^}]*usagePercent:${RE_NUM}[^}]*resetInSec:${RE_NUM}[^}]*\}`
  );
  const resetFirst = new RegExp(
    String.raw`${key}:\$R\[\d+\]=\{[^}]*resetInSec:${RE_NUM}[^}]*usagePercent:${RE_NUM}[^}]*\}`
  );
  return { pctFirst, resetFirst };
}

function extractWindow(html, key) {
  const { pctFirst, resetFirst } = reBothOrders(key);
  const m1 = html.match(pctFirst);
  if (m1) {
    const usagePercent = Number(m1[1]);
    const resetInSec = Number(m1[2]);
    if (Number.isFinite(usagePercent) && Number.isFinite(resetInSec)) {
      const used = Math.max(0, usagePercent);
      return { used, remaining: Math.max(0, 100 - used), resetInSec: Math.max(0, resetInSec) };
    }
  }
  const m2 = html.match(resetFirst);
  if (m2) {
    const resetInSec = Number(m2[1]);
    const usagePercent = Number(m2[2]);
    if (Number.isFinite(usagePercent) && Number.isFinite(resetInSec)) {
      const used = Math.max(0, usagePercent);
      return { used, remaining: Math.max(0, 100 - used), resetInSec: Math.max(0, resetInSec) };
    }
  }
  return null;
}

async function fetchGoDashboard(workspaceId, authCookie) {
  const res = await fetchWithTimeout(
    DASHBOARD_URL(workspaceId),
    {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html",
        Cookie: `auth=${authCookie}`,
      },
    },
    FETCH_TIMEOUT_MS,
  );
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const html = await res.text();
  const data = {
    rolling: extractWindow(html, "rollingUsage"),
    weekly: extractWindow(html, "weeklyUsage"),
    monthly: extractWindow(html, "monthlyUsage"),
  };
  if (!data.rolling && !data.weekly && !data.monthly)
    return { error: "No se encontraron datos de cuota en el dashboard" };
  return { data };
}

// ─── GitHub Copilot ──────────────────────────────────────

function readCopilotOAuthToken() {
  // Busca auth.json en los directorios de datos de OpenCode
  const candidates = [
    join(xdgDataHome(), "opencode", "auth.json"),
    join(require("os").homedir(), ".config", "opencode", "auth.json"),
  ];

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8"));
      // Busca la entrada de github-copilot
      const keys = ["github-copilot", "copilot", "copilot-chat", "github-copilot-chat"];
      for (const key of keys) {
        const entry = raw[key];
        if (entry?.type === "oauth" && entry.access) return entry.access;
      }
    } catch {}
  }
  return null;
}

async function fetchCopilotQuota() {
  const token = readCopilotOAuthToken();
  if (!token) return null;

  const res = await fetchWithTimeout(
    `${GITHUB_API}/copilot_internal/user`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": USER_AGENT,
      },
    },
    FETCH_TIMEOUT_MS,
  );
  if (!res.ok) return { error: `Copilot API HTTP ${res.status}` };

  const data = await res.json();

  // Busca total/used/remaining en varias rutas posibles del response
  const g = (paths) => {
    for (const p of paths) {
      let v = data;
      for (const k of p) {
        if (v == null || typeof v !== "object") { v = undefined; break; }
        v = v[k];
      }
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
    return undefined;
  };

  const totalPaths = [
    ["quota", "limit"], ["quota", "total"],
    ["monthly_quota", "limit"], ["monthly_quota", "total"],
    ["monthly_premium_requests", "limit"], ["monthly_premium_requests", "total"],
    ["premium_requests", "limit"], ["premium_requests", "total"],
    ["quota_snapshots", "premium_interactions", "entitlement"],
    ["limit"], ["total"], ["quota_limit"], ["monthly_limit"],
    ["included_premium_requests"],
    ["monthly_quotas", "chat"], ["monthly_quotas", "completions"],
  ];
  const usedPaths = [
    ["quota", "used"], ["monthly_quota", "used"],
    ["monthly_premium_requests", "used"],
    ["premium_requests", "used"],
    ["used"], ["quota_used"], ["monthly_used"],
    ["premium_requests_used"],
  ];
  const remainingPaths = [
    ["quota", "remaining"], ["monthly_quota", "remaining"],
    ["monthly_premium_requests", "remaining"],
    ["premium_requests", "remaining"],
    ["quota_snapshots", "premium_interactions", "remaining"],
    ["quota_snapshots", "premium_interactions", "quota_remaining"],
    ["remaining"], ["quota_remaining"], ["monthly_remaining"],
    ["premium_requests_remaining"],
    ["limited_user_quotas", "chat"], ["limited_user_quotas", "completions"],
  ];
  const resetPaths = [
    ["quota", "reset_at"], ["monthly_quota", "reset_at"],
    ["monthly_premium_requests", "reset_at"],
    ["premium_requests", "reset_at"],
    ["reset_at"], ["quota_reset_date_utc"], ["quota_reset_date"],
    ["limited_user_reset_date"],
  ];
  const unlimitedPaths = [
    ["quota", "unlimited"], ["monthly_quota", "unlimited"],
    ["monthly_premium_requests", "unlimited"],
    ["premium_requests", "unlimited"],
    ["quota_snapshots", "premium_interactions", "unlimited"],
    ["unlimited"],
  ];

  let total = g(totalPaths);
  let used = g(usedPaths);
  const remaining = g(remainingPaths);
  const unlimited = g(unlimitedPaths) === true;
  const resetAt = g(resetPaths);
  const tier = g([["plan", "type"], ["plan", "name"], ["plan"], ["copilot_plan"], ["subscription_plan"], ["sku"]]);

  // Si falta total pero tenemos used y remaining, calcular
  if (total === undefined && used !== undefined && remaining !== undefined)
    total = used + remaining;
  if (used === undefined && total !== undefined && remaining !== undefined)
    used = Math.max(0, total - remaining);
  // Fallback a limites por tier
  if (total === undefined && tier) {
    const limits = { free: 50, pro: 300, "pro+": 1500, business: 300, enterprise: 1000 };
    total = limits[tier?.toLowerCase()] ?? limits.pro;
  }

  if (unlimited) {
    return {
      used: Math.max(0, used ?? 0),
      unlimited: true,
      resetTimeIso: resetAt ? new Date(resetAt).toISOString() : undefined,
    };
  }

  if (total === undefined || total <= 0 || used === undefined || used < 0) {
    return { error: "No se pudieron extraer datos de cuota de Copilot" };
  }

  // Reset: si no viene, fin de mes proximo
  const resetTimeIso = resetAt
    ? new Date(resetAt).toISOString()
    : new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1)).toISOString();

  const remainingCount = Math.max(0, total - used);
  return {
    used,
    total,
    remaining: remainingCount,
    pctRemaining: total > 0 ? Math.round((remainingCount / total) * 100) : 0,
    resetTimeIso,
    unlimited: false,
  };
}

// ─── OpenRouter ───────────────────────────────────────

function readOpenRouterKey() {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (key) return key;

  // Fallback: leer ~/.config/opencode/openrouter-auth.json
  try {
    const path = join(require("os").homedir(), ".config", "opencode", "openrouter-auth.json");
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf-8"));
      for (const k of ["apiKey", "api_key", "token", "openrouterApiKey"]) {
        if (raw[k] && typeof raw[k] === "string") return raw[k].trim();
      }
    }
  } catch {}
  return null;
}

async function fetchOpenRouterQuota() {
  const key = readOpenRouterKey();
  if (!key) return null;

  const res = await fetchWithTimeout(
    "https://openrouter.ai/api/v1/credits",
    {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    },
    FETCH_TIMEOUT_MS,
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { error: `OpenRouter API HTTP ${res.status}: ${text.slice(0, 120)}` };
  }

  const body = await res.json();
  const d = body?.data ?? body;

  const totalCredits = typeof d.total_credits === "number" && Number.isFinite(d.total_credits) ? d.total_credits : null;
  const totalUsage = typeof d.total_usage === "number" && Number.isFinite(d.total_usage) ? d.total_usage : null;

  if (totalCredits !== null && totalCredits > 0) {
    const remaining = Math.max(0, totalCredits - (totalUsage ?? 0));
    const used = totalCredits - remaining;
    return {
      used,
      total: totalCredits,
      remaining,
      pctRemaining: Math.round((remaining / totalCredits) * 100),
      unit: "credits",
    };
  }

  if (totalUsage !== null) {
    return { usage: totalUsage, unit: "credits", total: null };
  }

  return { error: "OpenRouter API no devolvio datos de credito esperados" };
}

function formatOpenrouterSection(data) {
  const header = "── OpenRouter " + "─".repeat(25);
  if (data === null) return `${header}\n  Credits      ✗ no configurado`;
  if (data.error) return `${header}\n  Credits      ✗ ${data.error}`;
  if (data.total !== null) {
    return `${header}\n  Credits      $${data.remaining.toFixed(2)}`;
  }
  return `${header}\n  Credits      $${data.usage.toFixed(4)} used (no limit)`;
}

// ─── Formateo ────────────────────────────────────────────

const BAR_W = 14;

function formatResetTime(iso) {
  if (!iso) return "";
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "reseteando";
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function progressBar(pct) {
  const filled = Math.round(Math.min(pct, 100) / 100 * BAR_W);
  return "█".repeat(filled) + "░".repeat(BAR_W - filled);
}

function formatGoSection(data) {
  const header = "── OpenCode Go " + "─".repeat(24);
  const entries = [
    { name: "5h Rolling", d: data.rolling },
    { name: "Weekly", d: data.weekly },
    { name: "Monthly", d: data.monthly },
  ];
  const lines = [header];
  for (const { name, d } of entries) {
    if (!d) continue;
    const reset = formatResetTime(new Date(Date.now() + d.resetInSec * 1000).toISOString());
    const pct = d.remaining.toFixed(0).padStart(3);
    lines.push(`  ${name.padEnd(12)} ${progressBar(d.remaining)}  ${pct}%  · ${reset} left`);
  }
  return lines.join("\n");
}

function formatCopilotSection(data) {
  const header = "── GitHub Copilot " + "─".repeat(21);
  if (data === null) return `${header}\n  Monthly      ${" ".repeat(BAR_W + 1)}✗ no hay sesion`;
  if (data.error) return `${header}\n  Monthly      ${" ".repeat(BAR_W + 1)}✗ ${data.error}`;
  if (data.unlimited) return `${header}\n  Monthly      ${" ".repeat(BAR_W + 1)}Unlimited`;
  const reset = data.resetTimeIso ? formatResetTime(data.resetTimeIso) : "";
  const pct = String(data.pctRemaining).padStart(3);
  const ratio = `${data.remaining}/${data.total}`;
  const bar = progressBar(data.pctRemaining);
  const right = reset ? `· ${reset} left` : "";
  return `${header}\n  Monthly      ${bar}  ${pct}%  ${ratio}  ${right}`;
}

// ─── Plugin ────────────────────────────────────────────────

export const MyQuota = async ({ client }) => {

  return {
    config: async (cfg) => {
      if (!cfg.command) cfg.command = {};
      cfg.command["quota"] = {
        template: "Muestra cuota de OpenCode Go y GitHub Copilot",
        description: "Muestra cuota actual con barras de progreso",
      };
    },

    "command.execute.before": async (input, _output) => {
      if (input.command !== "quota") return;

      const sections = [];

      // ── OpenCode Go ──
      const goConfig = readGoConfig();
      if (goConfig) {
        const result = await fetchGoDashboard(goConfig.workspaceId, goConfig.authCookie);
        if (result.data) sections.push(formatGoSection(result.data));
        else sections.push(`── OpenCode Go ${"─".repeat(24)}\n  ✗ ${result.error}`);
      } else {
        sections.push(`── OpenCode Go ${"─".repeat(24)}\n  ✗ no configurado`);
      }

      // ── GitHub Copilot ──
      const copilotData = await fetchCopilotQuota();
      sections.push(formatCopilotSection(copilotData));

      // ── OpenRouter ──
      const orData = await fetchOpenRouterQuota();
      sections.push(formatOpenrouterSection(orData));

      const outputText = sections.join("\n\n");

      // Inyectar sin LLM
      await client.session.prompt({
        path: { id: input.sessionID },
        body: {
          noReply: true,
          parts: [{ type: "text", text: outputText, ignored: true }],
        },
      });

      try {
        await client.tui.showToast({
          body: { message: "/quota — consultado", variant: "info" },
        });
      } catch {}

      throw new Error("__QUOTA_COMMAND_HANDLED__");
    },
  };
};
