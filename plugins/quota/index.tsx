/** @jsxImportSource @opentui/solid */
import { createSignal, Show } from "solid-js";
import type { TuiPluginModule, TuiPluginApi } from "@opencode-ai/plugin/tui";
import {
  readGoConfig,
  fetchGoDashboard,
  fetchCopilotQuota,
  fetchOpenRouterQuota,
  fmtDuration,
} from "./providers.js";
import { createRefreshScheduler } from "./refresh-scheduler.js";

// --- Quota sidebar plugin: real-time API usage from 3 providers ---
// Fetches OpenCode Go, GitHub Copilot, and OpenRouter.
// Event-driven refresh with 120s polling fallback.

function View(props: { getLines: () => string[]; api: TuiPluginApi }) {
  const theme = () => props.api.theme.current;
  return (
    <box gap={0}>
      <text fg={theme().text}>Quota</text>
      <Show
        when={props.getLines().length > 0}
        fallback={
          <text fg={theme().textMuted} wrapMode="none">
            No data
          </text>
        }
      >
        {props.getLines().map((line) => (
          <text fg={theme().textMuted} wrapMode="none">
            {line}
          </text>
        ))}
      </Show>
    </box>
  );
}

// --- Plugin entry: signals, events, lifecycle ---
const plugin: TuiPluginModule & { id: string } = {
  id: "quota",

  tui: async (api) => {
    // Reactive state that drives the sidebar view
    // Guards for preventing work after unmount:
    const { slots, event: evt, lifecycle } = api;
    const [lines, setLines] = createSignal<string[]>([]);
    let currentSessionId = "";
    let inFlightVersion = 0;
    let disposed = false;
    // Stale-response guard: each refresh call gets a unique version.
    // When a newer call finishes first, older results are discarded.
    const IMMEDIATE_REFRESH_EVENTS = ["tui.session.select"];
    const COMPLETION_REFRESH_EVENTS = ["session.idle"];
    // Session select triggers immediate refresh.
    // Session idle (post-LLM-call) triggers a delayed refresh with staggered timers.

    // --- refresh() fetches all 3 providers sequentially ---
    // Sequential (not parallel) avoids rate limits and keeps error handling simple.
    async function refresh(source?: string) {
      if (disposed) return;
      // Each call gets a unique version number.
      // If a newer call finishes first, this one's results are stale and get discarded.
      const currentVersion = ++inFlightVersion;

      const results = new Map<string, string[] | string | null>();
      // results map encodes per-provider state:
      //   null      = loading (shows a spinner)
      //   string[]  = success (shows data lines)
      //   string    = error (shows error icon + message)

      // Mark configured providers as loading
      const goConfig = readGoConfig();
      if (goConfig) results.set("go", null);
      results.set("cp", null);
      results.set("or", null);
      // Only providers with config get marked. OpenCode Go is conditional;
      // Copilot and OpenRouter are always attempted.

      // --- buildLines() converts the results map to sidebar-ready text ---
      function buildLines() {
        const items: string[] = [];
        for (const [tag, key] of [
          ["OpenCode Go", "go"],
          ["GitHub Copilot", "cp"],
          ["OpenRouter", "or"],
        ] as const) {
          const r = results.get(key);
          if (r === undefined) continue;
          // undefined means this provider was never set: not configured, skip it.
          if (r === null) {
            // null means the fetch is still running, show a spinner.
            items.push(`${tag} ⏳`);
          } else if (typeof r === "string") {
            items.push(`${tag} ❌`);
            items.push(`  ${r}`);
          } else {
            items.push(tag);
            for (const line of r) items.push(`  ${line}`);
          }
          // string[] means data loaded successfully, display it.
        }
        return items;
      }

      setLines(buildLines());
      // Show loading state immediately, then update per-provider as results arrive.

      try {
        // ── OpenCode Go ──
        if (goConfig) {
          const result = await fetchGoDashboard(
            goConfig.workspaceId,
            goConfig.authCookie,
          );
          if (currentVersion !== inFlightVersion) return;
          // Stale check: discard if a newer refresh already finished.
          if ("data" in result) {
            const d = result.data;
            const dataLines: string[] = [];
            for (const [name, key] of [
              ["5h Rolling", "rolling"],
              ["Weekly", "weekly"],
              ["Monthly", "monthly"],
            ] as const) {
              const w = d[key];
              if (w)
                dataLines.push(
                  `${name}  ${w.remaining.toFixed(0)}%  · ${fmtDuration(w.resetInSec)} left`,
                );
            }
            results.set("go", dataLines.length ? dataLines : ["No windows"]);
          } else {
            results.set("go", result.error);
          }
          setLines(buildLines());
        }

        // --- Provider: GitHub Copilot (reads OAuth token from auth.json) ---
        // ── GitHub Copilot ──
        const cp = await fetchCopilotQuota();
        if (currentVersion !== inFlightVersion) return;
        if (cp === null) {
          results.delete("cp");
        } else if (!("error" in cp)) {
          const reset = cp.resetSec
            ? ` · ${fmtDuration(cp.resetSec)} left`
            : "";
          results.set("cp", [`Monthly  ${cp.text}${reset}`]);
        } else {
          results.set("cp", cp.error);
        }
        setLines(buildLines());

        // ── OpenRouter ──
        const or = await fetchOpenRouterQuota();
        if (currentVersion !== inFlightVersion) return;
        if (or === null) {
          results.delete("or");
        } else if (!("error" in or)) {
          results.set("or", [`Credits  ${or.text}`]);
        } else {
          results.set("or", or.error);
        }
        setLines(buildLines());
      } catch (e) {
        if (disposed || currentVersion !== inFlightVersion) return;
        const msg = `Error: ${e instanceof Error ? e.message : String(e)}`;
        setLines([msg]);
      }
      // Network errors or unexpected failures.
      // Both guards checked again because await can resolve after dispose.
    }
    // --- Event subscriptions: refresh on session select and idle ---
    const scheduler = createRefreshScheduler({
      subscribe: (eventName, handler) => evt.on(eventName as any, handler),
      onRefresh: refresh,
      immediateEvents: IMMEDIATE_REFRESH_EVENTS,
      completionEvents: COMPLETION_REFRESH_EVENTS,
    });
    lifecycle.onDispose(() => {
      disposed = true;
      scheduler.dispose();
    });
    // Fire-and-forget initial fetch (don't block slot registration)
    refresh().catch(() => {});

    slots.register({
      order: 180,
      slots: {
        sidebar_content(_ctx: any, slotInput: any) {
          const sid = (slotInput as any)?.session_id ?? "";
          if (sid && sid !== currentSessionId) {
            currentSessionId = sid;
            refresh(sid).catch(() => {});
          }
          return <View getLines={lines} api={api} />;
        },
      },
    });
  },
};

export default plugin;
