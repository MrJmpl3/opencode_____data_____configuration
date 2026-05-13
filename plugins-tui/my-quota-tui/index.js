import { createElement, insert, setProp } from "@opentui/solid";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

function element(tag, props, children = []) {
  const node = createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value !== undefined) setProp(node, key, value);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    insert(node, child);
  }
  return node;
}

function text(props, children) {
  return element("text", props, children);
}

function box(props, children = []) {
  return element("box", props, children);
}

function fetchWithTimeout(url, opts, ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { ...opts, signal: c.signal }).finally(() => clearTimeout(t));
}

// ─── Constants (copied verbatim from my-quota.js) ────────

const DASHBOARD_URL = (id) => `https://opencode.ai/workspace/${encodeURIComponent(id)}/go`;
const FETCH_TIMEOUT_MS = 10_000;
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0";

// ─── OpenCode Go (copied verbatim from my-quota.js) ──────

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
    return { error: "No quota data found in dashboard" };
  return { data };
}

// ─── GitHub Copilot ──────────────────────────────────────

function readCopilotToken() {
  const xdg = process.env.XDG_DATA_HOME || join(require("os").homedir(), ".local", "share");
  for (const p of [join(xdg, "opencode", "auth.json"), join(require("os").homedir(), ".config", "opencode", "auth.json")]) {
    if (!existsSync(p)) continue;
    try {
      const d = JSON.parse(readFileSync(p, "utf-8"));
      for (const k of ["github-copilot", "copilot", "copilot-chat", "github-copilot-chat"]) {
        const e = d[k];
        if (e?.type === "oauth" && e.access) return e.access;
      }
    } catch {}
  }
  return null;
}

async function fetchCopilotQuota() {
  const t = readCopilotToken();
  if (!t) return null;
  const r = await fetchWithTimeout("https://api.github.com/copilot_internal/user", {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${t}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Mozilla/5.0" },
  }, 10_000);
  if (!r.ok) return null;
  const d = await r.json();
  const find = (paths) => {
    for (const p of paths) {
      let v = d;
      for (const k of p) { if (v == null || typeof v !== "object") { v = undefined; break; } v = v[k]; }
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
  };
  let total = find([["quota","limit"],["quota","total"],["monthly_quota","limit"],["monthly_premium_requests","limit"],["premium_requests","limit"],["quota_snapshots","premium_interactions","entitlement"],["limit"],["total"],["monthly_limit"],["included_premium_requests"],["monthly_quotas","chat"],["monthly_quotas","completions"]]);
  let used = find([["quota","used"],["monthly_quota","used"],["monthly_premium_requests","used"],["premium_requests","used"],["used"],["quota_used"],["monthly_used"]]);
  const rem = find([["quota","remaining"],["monthly_quota","remaining"],["monthly_premium_requests","remaining"],["premium_requests","remaining"],["quota_snapshots","premium_interactions","remaining"],["quota_snapshots","premium_interactions","quota_remaining"],["remaining"],["quota_remaining"],["monthly_remaining"],["limited_user_quotas","chat"],["limited_user_quotas","completions"]]);
  if (total === undefined && used !== undefined && rem !== undefined) total = used + rem;
  if (used === undefined && total !== undefined && rem !== undefined) used = total - rem;
  if (total === undefined || total <= 0 || used === undefined || used < 0) return null;

  // Reset time
  const resetPaths = [
    ["quota", "reset_at"], ["monthly_quota", "reset_at"],
    ["monthly_premium_requests", "reset_at"], ["premium_requests", "reset_at"],
    ["reset_at"], ["quota_reset_date_utc"], ["quota_reset_date"],
    ["limited_user_reset_date"],
  ];
  let resetAt;
  for (const p of resetPaths) {
    let v = d;
    for (const k of p) { if (v == null || typeof v !== "object") { v = undefined; break; } v = v[k]; }
    if (v !== undefined && v !== null) { resetAt = v; break; }
  }
  const resetSeconds = resetAt ? Math.max(0, Math.floor((new Date(resetAt).getTime() - Date.now()) / 1000)) : undefined;

  return { text: `${total - used}/${total}`, resetSec: resetSeconds };
}

// ─── OpenRouter ──────────────────────────────────────────

async function fetchOpenRouterQuota() {
  const k = process.env.OPENROUTER_API_KEY?.trim();
  if (!k) return null;
  const r = await fetchWithTimeout("https://openrouter.ai/api/v1/credits", {
    headers: { Authorization: `Bearer ${k}`, Accept: "application/json" },
  }, 10_000);
  if (!r.ok) return null;
  const d = (await r.json())?.data ?? {};
  if (typeof d.total_credits === "number" && d.total_credits > 0) {
    return { text: `$${Math.max(0, d.total_credits - (d.total_usage ?? 0)).toFixed(2)}` };
  }
  return null;
}

// ─── Format ──────────────────────────────────────────────

function fmtTime(sec) {
  if (!sec || sec <= 0) return "";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtTimeIso(iso) {
  if (!iso) return "";
  return fmtTime(Math.max(0, Math.floor((new Date(iso).getTime() - Date.now()) / 1000)));
}

// ─── Sidebar render ──────────────────────────────────────

function renderSidebar(lines, theme) {
  const children = [text({ fg: theme.text }, ["Quota"])];
  if (lines.length > 0) {
    for (const line of lines) {
      children.push(text({ fg: theme.textMuted, wrapMode: "none" }, [line]));
    }
  } else {
    children.push(text({ fg: theme.textMuted, wrapMode: "none" }, ["No data"]));
  }
  return box({ gap: 0 }, children);
}

// ─── Plugin ──────────────────────────────────────────────

const plugin = {
  id: "@my/quota-tui",

  tui: async (api) => {
    let lines = [];
    let refreshQueued = false;
    let refreshTimer = null;

    async function refresh() {
      try {
        refreshQueued = false;
        const items = [];

        // OpenCode Go
        const goConfig = readGoConfig();
        if (goConfig) {
          const result = await fetchGoDashboard(goConfig.workspaceId, goConfig.authCookie);
          if (result.data) {
            const d = result.data;
            items.push(`OpenCode Go`);
            for (const [name, key] of [["5h Rolling","rolling"],["Weekly","weekly"],["Monthly","monthly"]]) {
              const w = d[key];
              if (w) items.push(`  ${name}  ${w.remaining.toFixed(0)}%  · ${fmtTime(w.resetInSec)} left`);
            }
          }
        }

        // GitHub Copilot
        const cp = await fetchCopilotQuota();
        if (cp) items.push(`GitHub Copilot`);
        if (cp) items.push(`  Monthly  ${cp.text}${cp.resetSec ? `  · ${fmtTime(cp.resetSec)} left` : ""}`);

        // OpenRouter
        const or = await fetchOpenRouterQuota();
        if (or) items.push(`OpenRouter`);
        if (or) items.push(`  Credits  ${or.text}`);

        lines = items;
      } catch (e) {
        lines = [`Error: ${e?.message ?? e}`];
      }

      api.renderer.requestRender();
    }

    // Debounced refresh: if called multiple times within 500ms, only runs once
    function queueRefresh() {
      if (refreshQueued) return;
      refreshQueued = true;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        refresh().catch(() => {});
      }, 500);
    }

    // Refresh on events: LLM response, session changes, etc.
    const unsubscribers = [
      api.event.on("message.updated", () => queueRefresh()),
      api.event.on("session.updated", () => queueRefresh()),
      api.event.on("message.removed", () => queueRefresh()),
      api.event.on("tui.session.select", () => queueRefresh()),
    ];
    api.lifecycle.onDispose(() => {
      for (const unsub of unsubscribers) unsub();
      clearTimeout(refreshTimer);
    });

    // Initial load
    await refresh();

    // Fallback refresh every 120s in case events don't fire
    const fallbackTimer = setInterval(() => queueRefresh(), 120_000);
    api.lifecycle.onDispose(() => clearInterval(fallbackTimer));

    api.slots.register({
      order: 250,
      slots: {
        sidebar_content() {
          return renderSidebar(lines, api.theme.current);
        },
      },
    });
  },
};

export default plugin;
