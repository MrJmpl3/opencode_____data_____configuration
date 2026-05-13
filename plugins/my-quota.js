/**
 * my-quota — Server plugin for OpenCode.
 *
 * Registers /quota slash command that shows quota data from
 * OpenCode Go, GitHub Copilot, and OpenRouter.
 *
 * Data fetching lives in lib/quota-providers.js (shared with TUI plugin).
 */

import {
  fetchGoDashboard,
  readGoConfig,
  fetchCopilotQuota,
  fetchOpenRouterQuota,
  progressBar,
  fmtDuration,
  fmtDurationIso,
} from "./lib/quota-providers.js";

// ═══════════════════════════════════════════════════════════
// Formatting (server plugin: /quota output)
// ═══════════════════════════════════════════════════════════

function formatGoSection(data) {
  const entries = [
    { name: "5h Rolling", key: "rolling" },
    { name: "Weekly", key: "weekly" },
    { name: "Monthly", key: "monthly" },
  ];

  const lines = [`── OpenCode Go ${"─".repeat(24)}`];
  for (const { name, key } of entries) {
    const w = data[key];
    if (!w) continue;
    const reset = fmtDuration(w.resetInSec);
    const pct = String(w.remaining).padStart(3);
    lines.push(`  ${name.padEnd(12)} ${progressBar(w.remaining)}  ${pct}%  · ${reset} left`);
  }
  return lines.join("\n");
}

function formatCopilotSection(data) {
  const header = `── GitHub Copilot ${"─".repeat(21)}`;
  if (data === null) return `${header}\n  Monthly      ${" ".repeat(15)}✗ no active session`;
  if (data.error) return `${header}\n  Monthly      ${" ".repeat(15)}✗ ${data.error}`;
  if (data.unlimited) return `${header}\n  Monthly      ${" ".repeat(15)}Unlimited`;

  const reset = data.resetTimeIso ? fmtDurationIso(data.resetTimeIso) : "";
  const pct = String(data.pctRemaining ?? 0).padStart(3);
  const bar = progressBar(data.pctRemaining ?? 0);
  const right = reset ? `· ${reset} left` : "";
  return `${header}\n  Monthly      ${bar}  ${pct}%  ${data.text}  ${right}`;
}

function formatOpenrouterSection(data) {
  const header = `── OpenRouter ${"─".repeat(25)}`;
  if (data === null) return `${header}\n  Credits      ✗ not configured`;
  if (data.error) return `${header}\n  Credits      ✗ ${data.error}`;
  if (data.usage && !data.total) {
    return `${header}\n  Credits      ${data.text}`;
  }
  return `${header}\n  Credits      ${data.text}`;
}

// ═══════════════════════════════════════════════════════════
// Plugin
// ═══════════════════════════════════════════════════════════

export const MyQuota = async ({ client }) => {
  return {
    config: async (cfg) => {
      if (!cfg.command) cfg.command = {};
      cfg.command["quota"] = {
        template: "Shows OpenCode Go, GitHub Copilot and OpenRouter quota",
        description: "Shows current quota with progress bars",
      };
    },

    "command.execute.before": async (input, _output) => {
      if (input.command !== "quota") return;

      const sections = [];

      // ── OpenCode Go ──
      const goConfig = readGoConfig();
      if (goConfig) {
        const result = await fetchGoDashboard(goConfig.workspaceId, goConfig.authCookie);
        sections.push(
          result.data
            ? formatGoSection(result.data)
            : `── OpenCode Go ${"─".repeat(24)}\n  ✗ ${result.error}`
        );
      } else {
        sections.push(`── OpenCode Go ${"─".repeat(24)}\n  ✗ not configured`);
      }

      // ── GitHub Copilot ──
      sections.push(formatCopilotSection(await fetchCopilotQuota()));

      // ── OpenRouter ──
      sections.push(formatOpenrouterSection(await fetchOpenRouterQuota()));

      const outputText = sections.join("\n\n");

      // Inject into session without LLM
      await client.session.prompt({
        path: { id: input.sessionID },
        body: {
          noReply: true,
          parts: [{ type: "text", text: outputText, ignored: true }],
        },
      });

      try {
        await client.tui.showToast({
          body: { message: "/quota — checked", variant: "info" },
        });
      } catch { /* no TUI */ }

      throw new Error("__QUOTA_COMMAND_HANDLED__");
    },
  };
};
