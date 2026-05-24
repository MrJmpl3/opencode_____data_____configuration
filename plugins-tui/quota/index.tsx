/** @jsxImportSource @opentui/solid */
import { createSignal, Show } from "solid-js";
import type { TuiPluginModule, TuiPluginApi } from "@opencode-ai/plugin/tui";
import {
  readGoConfig,
  fetchGoDashboard,
  fetchCopilotQuota,
  fetchOpenRouterQuota,
  fetchOpenAIQuota,
  fmtDuration,
} from "./providers.js";
import { createRefreshScheduler } from "./refresh-scheduler.js";

// --- Quota sidebar plugin: real-time API usage across multiple providers ---
// Fetches configured providers and renders them in the sidebar.
// Event-driven refresh with 120s polling fallback.

type QuotaProviderId = "go" | "copilot" | "openrouter" | "openai";
type QuotaDisplayMode = "remaining" | "used";

type QuotaPluginOptions = {
  compact?: boolean;
  displayMode?: QuotaDisplayMode;
  visibleProviders?: readonly string[];
};

type ProviderSpec = {
  id: QuotaProviderId;
  compactLabel: string;
  label: string;
};

const PROVIDER_SPECS: readonly ProviderSpec[] = [
  { id: "go", compactLabel: "Go", label: "OpenCode Go" },
  { id: "copilot", compactLabel: "Copilot", label: "GitHub Copilot" },
  { id: "openrouter", compactLabel: "Router", label: "OpenRouter" },
  { id: "openai", compactLabel: "OpenAI", label: "OpenAI" },
];

const DEFAULT_VISIBLE_PROVIDERS: readonly QuotaProviderId[] = [
  "go",
  "copilot",
  "openrouter",
];

const detailLine = (text: string): string => `  ${text}`;

const normalizeProviderId = (value: string): QuotaProviderId | undefined => {
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "go":
    case "opencode-go":
      return "go";
    case "copilot":
    case "cp":
    case "github-copilot":
      return "copilot";
    case "openrouter":
    case "or":
      return "openrouter";
    case "openai":
    case "oa":
    case "chatgpt":
      return "openai";
    default:
      return undefined;
  }
};

const getVisibleProviders = (options: unknown): readonly ProviderSpec[] => {
  const configured =
    options && typeof options === "object"
      ? (options as QuotaPluginOptions).visibleProviders
      : undefined;
  if (!Array.isArray(configured) || configured.length === 0) {
    return PROVIDER_SPECS.filter((spec) =>
      DEFAULT_VISIBLE_PROVIDERS.includes(spec.id),
    );
  }

  const ids = new Set<QuotaProviderId>();
  for (const raw of configured) {
    if (typeof raw !== "string") continue;
    const id = normalizeProviderId(raw);
    if (id) ids.add(id);
  }

  if (ids.size === 0) {
    return PROVIDER_SPECS.filter((spec) =>
      DEFAULT_VISIBLE_PROVIDERS.includes(spec.id),
    );
  }

  return PROVIDER_SPECS.filter((spec) => ids.has(spec.id));
};

const getCompactSetting = (options: unknown): boolean => {
  if (!options || typeof options !== "object") return true;
  const compact = (options as QuotaPluginOptions).compact;
  return typeof compact === "boolean" ? compact : true;
};

const getDisplayModeSetting = (options: unknown): QuotaDisplayMode => {
  if (!options || typeof options !== "object") return "remaining";
  return (options as QuotaPluginOptions).displayMode === "used"
    ? "used"
    : "remaining";
};

const formatPercentQuota = (
  used: number,
  remaining: number,
  displayMode: QuotaDisplayMode,
): string => {
  if (displayMode === "used") return `${used.toFixed(0)}/100`;
  return `${remaining.toFixed(0)}%`;
};

const formatUsedPercentQuota = (
  usedPct: number,
  displayMode: QuotaDisplayMode,
): string => {
  const used = Math.max(0, Math.min(100, usedPct));
  return formatPercentQuota(used, Math.max(0, 100 - used), displayMode);
};

const formatCountQuota = (
  data: { text: string; used?: number; remaining?: number; total?: number },
  displayMode: QuotaDisplayMode,
): string => {
  const { used, remaining, total } = data;
  if (typeof total !== "number" || total <= 0) return data.text;

  const value =
    displayMode === "used"
      ? (used ??
        (typeof remaining === "number" ? total - remaining : undefined))
      : (remaining ?? (typeof used === "number" ? total - used : undefined));

  if (typeof value !== "number" || !Number.isFinite(value)) return data.text;
  return `${Math.max(0, value).toFixed(0)}/${total.toFixed(0)}`;
};

const formatCreditQuota = (
  data: { text: string; usage?: number; remaining?: number; total?: number },
  displayMode: QuotaDisplayMode,
): string => {
  const { usage, remaining, total } = data;
  if (typeof total !== "number" || total <= 0) return data.text;

  const value =
    displayMode === "used"
      ? (usage ??
        (typeof remaining === "number" ? total - remaining : undefined))
      : (remaining ?? (typeof usage === "number" ? total - usage : undefined));

  if (typeof value !== "number" || !Number.isFinite(value)) return data.text;
  if (displayMode === "remaining") return data.text;
  return `$${Math.max(0, value).toFixed(2)}/$${total.toFixed(2)}`;
};

const bestGoCompactLine = (
  provider: ProviderSpec,
  displayMode: QuotaDisplayMode,
  windows: {
    rolling: { used: number; remaining: number; resetInSec: number } | null;
    weekly: { used: number; remaining: number; resetInSec: number } | null;
    monthly: { used: number; remaining: number; resetInSec: number } | null;
  },
): string[] => {
  const best = windows.rolling
    ? { label: "5h", window: windows.rolling }
    : windows.weekly
      ? { label: "Week", window: windows.weekly }
      : windows.monthly
        ? { label: "Month", window: windows.monthly }
        : null;
  if (!best) return [`${provider.compactLabel}: no windows`];
  return [
    `${provider.compactLabel}: ${best.label} ${formatPercentQuota(best.window.used, best.window.remaining, displayMode)}`,
  ];
};

const bestOpenAICompactLine = (
  provider: ProviderSpec,
  displayMode: QuotaDisplayMode,
  data: {
    planType?: string;
    hourly?: { usedPct: number; resetSec: number };
    weekly?: { usedPct: number; resetSec: number };
    codeReview?: { usedPct: number; resetSec: number };
    credits?: string;
  },
): string[] => {
  if (data.hourly) {
    const lines = [
      `${provider.compactLabel}: 5h ${formatUsedPercentQuota(data.hourly.usedPct, displayMode)}`,
    ];
    if (data.weekly) {
      lines.push(
        `Week ${formatUsedPercentQuota(data.weekly.usedPct, displayMode)}`,
      );
    }
    return lines;
  }
  if (data.weekly) {
    return [
      `${provider.compactLabel}: Week ${formatUsedPercentQuota(data.weekly.usedPct, displayMode)}`,
    ];
  }
  if (data.codeReview) {
    return [
      `${provider.compactLabel}: Review ${formatUsedPercentQuota(data.codeReview.usedPct, displayMode)}`,
    ];
  }
  if (data.credits) {
    return [`${provider.compactLabel}: Credits ${data.credits}`];
  }
  return [`${provider.compactLabel}: no windows`];
};

const bestCopilotCompactLine = (
  provider: ProviderSpec,
  data: { text: string },
): string[] => {
  return [`${provider.compactLabel}: ${data.text}`];
};

const bestOpenRouterCompactLine = (
  provider: ProviderSpec,
  data: { text: string },
): string[] => {
  return [`${provider.compactLabel}: ${data.text}`];
};

const View = (props: { getLines: () => string[]; api: TuiPluginApi }) => {
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
};

// --- Plugin entry: signals, events, lifecycle ---
const plugin: TuiPluginModule & { id: string } = {
  id: "quota",

  tui: async (api, options) => {
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
    const compact = getCompactSetting(options);
    const displayMode = getDisplayModeSetting(options);
    const visibleProviders = getVisibleProviders(options);
    // Session select triggers immediate refresh.
    // Session idle (post-LLM-call) triggers a delayed refresh with staggered timers.

    // --- refresh() fetches configured providers sequentially ---
    // Sequential (not parallel) avoids rate limits and keeps error handling simple.
    const refresh = async (source?: string) => {
      if (disposed) return;
      // Each call gets a unique version number.
      // If a newer call finishes first, this one's results are stale and get discarded.
      const currentVersion = ++inFlightVersion;

      const results = new Map<QuotaProviderId, string[] | string | null>();
      // results map encodes per-provider state:
      //   null      = loading (shows a spinner)
      //   string[]  = success (shows data lines)
      //   string    = error (shows error icon + message)

      // Mark configured providers as loading
      const goConfig = readGoConfig();
      for (const provider of visibleProviders) {
        if (provider.id === "go" && !goConfig) continue;
        results.set(provider.id, null);
      }
      // Only providers with config get marked. OpenCode Go is conditional;
      // Copilot and OpenRouter are always attempted.

      // --- buildLines() converts the results map to sidebar-ready text ---
      const buildLines = () => {
        const items: string[] = [];
        for (const provider of visibleProviders) {
          const r = results.get(provider.id);
          if (r === undefined) continue;
          // undefined means this provider was never set: not configured, skip it.
          if (r === null) {
            // null means the fetch is still running, show a spinner.
            if (compact) {
              items.push(`${provider.compactLabel}: refreshing`);
            } else {
              items.push(provider.label);
              items.push(detailLine("Refreshing…"));
            }
          } else if (typeof r === "string") {
            if (compact) {
              items.push(`${provider.compactLabel}: ${r}`);
            } else {
              items.push(provider.label);
              items.push(detailLine(`Unavailable · ${r}`));
            }
          } else {
            if (compact) {
              items.push(...r);
            } else {
              items.push(provider.label);
              for (const line of r) items.push(detailLine(line));
            }
          }
          // string[] means data loaded successfully, display it.
        }
        return items;
      };

      setLines(buildLines());
      // Show loading state immediately, then update per-provider as results arrive.

      try {
        // ── OpenCode Go ──
        if (goConfig && results.has("go")) {
          const result = await fetchGoDashboard(
            goConfig.workspaceId,
            goConfig.authCookie,
          );
          if (currentVersion !== inFlightVersion) return;
          // Stale check: discard if a newer refresh already finished.
          if ("data" in result) {
            const d = result.data;
            const dataLines: string[] = compact
              ? bestGoCompactLine(PROVIDER_SPECS[0], displayMode, d)
              : [];
            if (!compact) {
              for (const [name, key] of [
                ["5h window", "rolling"],
                ["Weekly", "weekly"],
                ["Monthly", "monthly"],
              ] as const) {
                const w = d[key];
                if (w)
                  dataLines.push(
                    `${name} · ${formatPercentQuota(w.used, w.remaining, displayMode)} · ${fmtDuration(w.resetInSec)} left`,
                  );
              }
            }
            results.set("go", dataLines.length ? dataLines : ["No windows"]);
          } else {
            results.set("go", result.error);
          }
          setLines(buildLines());
        }

        // --- Provider: GitHub Copilot (reads OAuth token from auth.json) ---
        // ── GitHub Copilot ──
        if (results.has("copilot")) {
          const cp = await fetchCopilotQuota();
          if (currentVersion !== inFlightVersion) return;
          if (cp === null) {
            results.delete("copilot");
          } else if (!("error" in cp)) {
            const reset = cp.resetSec
              ? ` · ${fmtDuration(cp.resetSec)} left`
              : "";
            results.set(
              "copilot",
              compact
                ? bestCopilotCompactLine(PROVIDER_SPECS[1], {
                    text: formatCountQuota(cp, displayMode),
                  })
                : [`Monthly · ${formatCountQuota(cp, displayMode)}${reset}`],
            );
          } else {
            results.set("copilot", cp.error);
          }
          setLines(buildLines());
        }

        // ── OpenRouter ──
        if (results.has("openrouter")) {
          const or = await fetchOpenRouterQuota();
          if (currentVersion !== inFlightVersion) return;
          if (or === null) {
            results.delete("openrouter");
          } else if (!("error" in or)) {
            results.set(
              "openrouter",
              compact
                ? bestOpenRouterCompactLine(PROVIDER_SPECS[2], {
                    text: formatCreditQuota(or, displayMode),
                  })
                : [`Credits · ${formatCreditQuota(or, displayMode)}`],
            );
          } else {
            results.set("openrouter", or.error);
          }
          setLines(buildLines());
        }

        // ── OpenAI ──
        if (results.has("openai")) {
          const oa = await fetchOpenAIQuota();
          if (currentVersion !== inFlightVersion) return;
          if (oa === null) {
            results.delete("openai");
          } else if (!("error" in oa)) {
            const dataLines: string[] = compact
              ? bestOpenAICompactLine(PROVIDER_SPECS[3], displayMode, oa)
              : [];
            if (!compact) {
              const addWindow = (
                label: string,
                window: { usedPct: number; resetSec: number } | undefined,
              ) => {
                if (!window) return;
                dataLines.push(
                  `${label} · ${formatUsedPercentQuota(window.usedPct, displayMode)} · ${fmtDuration(window.resetSec)} left`,
                );
              };

              addWindow("5h", oa.hourly);
              addWindow("Weekly", oa.weekly);
              addWindow("Code Review", oa.codeReview);
              if (oa.credits) dataLines.push(`Credits · ${oa.credits}`);
            }

            results.set(
              "openai",
              dataLines.length ? dataLines : ["No windows"],
            );
          } else {
            results.set("openai", oa.error);
          }
          setLines(buildLines());
        }
      } catch (e) {
        if (disposed || currentVersion !== inFlightVersion) return;
        const msg = `Error: ${e instanceof Error ? e.message : String(e)}`;
        setLines([msg]);
      }
      // Network errors or unexpected failures.
      // Both guards checked again because await can resolve after dispose.
    };
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
        sidebar_content: (_ctx: any, slotInput: any) => {
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
