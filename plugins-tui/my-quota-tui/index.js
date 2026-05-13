/**
 * my-quota-tui — Sidebar panel for OpenCode TUI.
 *
 * Shows real-time quota from OpenCode Go, GitHub Copilot, and OpenRouter.
 * Refreshes automatically on LLM response and session changes.
 *
 * Data fetching lives in lib/quota-providers.js (shared with server plugin).
 */

import { createElement, insert, setProp } from "@opentui/solid";
import {
  readGoConfig,
  fetchGoDashboard,
  fetchCopilotQuota,
  fetchOpenRouterQuota,
  fmtDuration,
} from "../../plugins/lib/quota-providers.js";

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
    let refreshQueued = false;
    let refreshTimer = null;

    async function refresh() {
      try {
        refreshQueued = false;
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

        lines = items;
      } catch (e) {
        lines = [`Error: ${e?.message ?? e}`];
      }

      api.renderer.requestRender();
    }

    // Debounced refresh: coalesces rapid events into a single call
    function queueRefresh() {
      if (refreshQueued) return;
      refreshQueued = true;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        refresh().catch(() => {});
      }, 500);
    }

    // Refresh on LLM response / session changes
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

    // Initial data load
    await refresh();

    // Fallback: refresh every 2min in case events are silent
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
