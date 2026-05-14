/**
 * my-quota-tui — Sidebar panel for OpenCode TUI.
 *
 * Shows real-time quota from OpenCode Go, GitHub Copilot, and OpenRouter.
 * Refreshes automatically on LLM response and session changes.
 *
 * Data fetching lives in libs/quota.js (shared with server plugin).
 */

import { createElement, insert, setProp } from "@opentui/solid";
import {
  readGoConfig,
  fetchGoDashboard,
  fetchCopilotQuota,
  fetchOpenRouterQuota,
  fmtDuration,
} from "../../libs/quota.js";

// ═══════════════════════════════════════════════════════════
// TUI element helpers (pattern: oh-my-opencode-slim)
// ═══════════════════════════════════════════════════════════

function el(tag, props, children = []) {
  const node = createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value !== undefined) setProp(node, key, value);
  }
  for (const child of children) {
    if (child == null || child === false) continue;
    insert(node, child);
  }
  return node;
}

function txt(props, children) {
  return el("text", props, children);
}

function box(props, children = []) {
  return el("box", props, children);
}

// ═══════════════════════════════════════════════════════════
// Sidebar render
// ═══════════════════════════════════════════════════════════

function renderSidebar(lines, theme) {
  const children = [txt({ fg: theme.text }, ["Quota"])];
  if (lines.length > 0) {
    for (const line of lines) {
      children.push(txt({ fg: theme.textMuted, wrapMode: "none" }, [line]));
    }
  } else {
    children.push(txt({ fg: theme.textMuted, wrapMode: "none" }, ["No data"]));
  }
  return box({ gap: 0 }, children);
}

// ═══════════════════════════════════════════════════════════
// Plugin
// ═══════════════════════════════════════════════════════════

const plugin = {
  id: "@my/quota-tui",

  tui: async (api) => {
    let lines = [];
    let inFlightVersion = 0;
    const pendingTimers = new Set();
    const REFRESH_DELAYS_MS = [150, 600];
    let disposed = false;
    let fallbackTimer = null;

    async function refresh() {
      if (disposed) return;
      const currentVersion = ++inFlightVersion;
      try {
        const items = [];

        // ── OpenCode Go ──
        const goConfig = readGoConfig();
        if (goConfig) {
          const result = await fetchGoDashboard(goConfig.workspaceId, goConfig.authCookie);
          if (result.data) {
            const d = result.data;
            items.push("OpenCode Go");
            for (const [name, key] of [["5h Rolling", "rolling"], ["Weekly", "weekly"], ["Monthly", "monthly"]]) {
              const w = d[key];
              if (w) items.push(`  ${name}  ${w.remaining.toFixed(0)}%  · ${fmtDuration(w.resetInSec)} left`);
            }
          }
        }

        // ── GitHub Copilot ──
        const cp = await fetchCopilotQuota();
        if (cp && !cp.error) {
          items.push("GitHub Copilot");
          const reset = cp.resetSec ? `  · ${fmtDuration(cp.resetSec)} left` : "";
          items.push(`  Monthly  ${cp.text}${reset}`);
        }

        // ── OpenRouter ──
        const or = await fetchOpenRouterQuota();
        if (or && !or.error) {
          items.push("OpenRouter");
          items.push(`  Credits  ${or.text}`);
        }
        if (currentVersion !== inFlightVersion) return;
        lines = items;
      } catch (e) {
        if (disposed || currentVersion !== inFlightVersion) return;
        lines = [`Error: ${e?.message ?? e}`];
      }

      api.renderer.requestRender();
    }
    // --- refresh strategy ---
    // We refresh in two waves:
    // 1) fast retries for UI/session transitions
    // 2) a delayed retry for LLM completion, which can lag behind streaming events
    function scheduleRefresh(extraDelays = []) {
      for (const delay of [...REFRESH_DELAYS_MS, ...extraDelays]) {
        const timer = setTimeout(() => {
          if (disposed) return;
          pendingTimers.delete(timer);
          refresh();
        }, delay);
        pendingTimers.add(timer);
      }
    }
    // --- event subscriptions ---
    // `session.idle` is the strongest “the model stopped writing” signal we have.
    // `message.*` stays as a fallback because different flows emit different events.
    const unsubscribers = [
      api.event.on("message.part.updated", () => scheduleRefresh([5000])),
      api.event.on("message.updated", () => scheduleRefresh([5000])),
      api.event.on("session.updated", () => scheduleRefresh()),
      api.event.on("session.status", () => scheduleRefresh()),
      api.event.on("session.idle", () => scheduleRefresh([5000])),
      api.event.on("message.removed", () => scheduleRefresh()),
      api.event.on("tui.session.select", () => scheduleRefresh()),
    ];
    api.lifecycle.onDispose(() => {
      disposed = true;
      for (const unsub of unsubscribers) unsub();
      for (const timer of pendingTimers) clearTimeout(timer);
      pendingTimers.clear();
      if (fallbackTimer) clearInterval(fallbackTimer);
    });

    // Initial data load
    await refresh();

    fallbackTimer = setInterval(() => refresh(), 120_000);

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
