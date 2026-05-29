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
  displayMode?: QuotaDisplayMode;
  visibleProviders?: readonly string[];
};

type ProviderSpec = {
  id: QuotaProviderId;
  label: string;
};

type PercentWindow = {
  usedPct: number;
  resetSec: number;
  limitWindowSec?: number;
};

type QuotaLine =
  | { kind: "heading"; text: string }
  | { kind: "detail"; text: string }
  | { kind: "window"; label: string; value: string; resetAtMs: number }
  | { kind: "pace"; usedPct: number; resetAtMs: number; windowSeconds: number };

type ProviderResult = QuotaLine[] | string | null;

const PROVIDER_SPECS: readonly ProviderSpec[] = [
  { id: "go", label: "OpenCode Go" },
  { id: "copilot", label: "GitHub Copilot" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "openai", label: "OpenAI" },
];

const DEFAULT_VISIBLE_PROVIDERS: readonly QuotaProviderId[] = ["go", "copilot", "openrouter"];

const detailLine = (text: string): string => `  ${text}`;
const headingLine = (text: string): QuotaLine => ({ kind: "heading", text });
const detailTextLine = (text: string): QuotaLine => ({ kind: "detail", text });
const resetAtMsFromSeconds = (resetSec: number, capturedAtMs: number): number =>
  capturedAtMs + Math.max(0, Math.floor(resetSec)) * 1000;
const remainingSeconds = (resetAtMs: number, nowMs: number): number =>
  Math.max(0, Math.ceil((resetAtMs - nowMs) / 1000));
const windowLine = (
  label: string,
  value: string,
  resetSec: number,
  capturedAtMs: number,
): QuotaLine => ({
  kind: "window",
  label,
  value,
  resetAtMs: resetAtMsFromSeconds(resetSec, capturedAtMs),
});
const paceLine = (
  window: PercentWindow,
  windowSeconds: number,
  capturedAtMs: number,
): QuotaLine => ({
  kind: "pace",
  usedPct: window.usedPct,
  resetAtMs: resetAtMsFromSeconds(window.resetSec, capturedAtMs),
  windowSeconds,
});

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
    return PROVIDER_SPECS.filter((spec) => DEFAULT_VISIBLE_PROVIDERS.includes(spec.id));
  }

  const ids = new Set<QuotaProviderId>();
  for (const raw of configured) {
    if (typeof raw !== "string") continue;
    const id = normalizeProviderId(raw);
    if (id) ids.add(id);
  }

  if (ids.size === 0) {
    return PROVIDER_SPECS.filter((spec) => DEFAULT_VISIBLE_PROVIDERS.includes(spec.id));
  }

  return PROVIDER_SPECS.filter((spec) => ids.has(spec.id));
};

const getDisplayModeSetting = (options: unknown): QuotaDisplayMode => {
  if (!options || typeof options !== "object") return "remaining";
  return (options as QuotaPluginOptions).displayMode === "used" ? "used" : "remaining";
};

const formatPercentQuota = (
  used: number,
  remaining: number,
  displayMode: QuotaDisplayMode,
): string => {
  if (displayMode === "used") return `${used.toFixed(0)}%`;
  return `${remaining.toFixed(0)}%`;
};

const formatUsedPercentQuota = (usedPct: number, displayMode: QuotaDisplayMode): string => {
  const used = Math.max(0, Math.min(100, usedPct));
  return formatPercentQuota(used, Math.max(0, 100 - used), displayMode);
};

const WEEK_SECONDS = 7 * 24 * 60 * 60;

export const formatResponsibleUsagePace = (
  window: {
    usedPct: number;
    resetSec: number;
  },
  windowSeconds: number,
): string => {
  const totalSec = Math.max(1, windowSeconds);
  const usedPct = Math.max(0, Math.min(100, window.usedPct));
  const remainingSec = Math.max(0, Math.min(totalSec, window.resetSec));
  const responsibleRemainingPct = (remainingSec / totalSec) * 100;
  const responsibleUsedPct = 100 - responsibleRemainingPct;
  const deltaPct = usedPct - responsibleUsedPct;
  const absDelta = Math.abs(deltaPct).toFixed(2);

  if (deltaPct <= 0) {
    return `✓ ok · ${absDelta}% below`;
  }

  return `⚠ high · ${absDelta}% over`;
};

export const formatResponsibleWeeklyUsage = (window: {
  usedPct: number;
  resetSec: number;
}): string => formatResponsibleUsagePace(window, WEEK_SECONDS);

const formatOpenAIRateLimitStatus = (limit: {
  allowed?: boolean;
  limitReached?: boolean;
}): string | undefined => {
  if (limit.limitReached) return "limit reached";
  if (limit.allowed === false) return "blocked";
  if (limit.allowed === true) return "available";
  return undefined;
};

const isOpenAISparkRateLimit = (limit: {
  label: string;
  limitName?: string;
  meteredFeature?: string;
}): boolean => {
  const haystack = [limit.label, limit.limitName, limit.meteredFeature]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
  return haystack.includes("spark") || haystack.includes("codex");
};

const renderQuotaLine = (line: QuotaLine, nowMs: number): string => {
  switch (line.kind) {
    case "heading":
      return line.text;
    case "detail":
      return detailLine(line.text);
    case "window":
      return detailLine(
        `${line.label} · ${line.value} · ${fmtDuration(remainingSeconds(line.resetAtMs, nowMs))} left`,
      );
    case "pace":
      return detailLine(
        `Usage pace · ${formatResponsibleUsagePace(
          {
            usedPct: line.usedPct,
            resetSec: remainingSeconds(line.resetAtMs, nowMs),
          },
          line.windowSeconds,
        )}`,
      );
  }
};

const formatCountQuota = (
  data: { text: string; used?: number; remaining?: number; total?: number },
  displayMode: QuotaDisplayMode,
): string => {
  const { used, remaining, total } = data;
  if (typeof total !== "number" || total <= 0) return data.text;

  const value =
    displayMode === "used"
      ? (used ?? (typeof remaining === "number" ? total - remaining : undefined))
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
      ? (usage ?? (typeof remaining === "number" ? total - remaining : undefined))
      : (remaining ?? (typeof usage === "number" ? total - usage : undefined));

  if (typeof value !== "number" || !Number.isFinite(value)) return data.text;
  if (displayMode === "remaining") return data.text;
  return `$${Math.max(0, value).toFixed(2)}/$${total.toFixed(2)}`;
};

const View = (props: {
  getLines: () => QuotaLine[];
  getNowMs: () => number;
  api: TuiPluginApi;
}) => {
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
            {renderQuotaLine(line, props.getNowMs())}
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
    const [lines, setLines] = createSignal<QuotaLine[]>([]);
    const [nowMs, setNowMs] = createSignal(Date.now());
    let currentSessionId = "";
    let inFlightVersion = 0;
    let disposed = false;
    let clockTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleClockTick = () => {
      const delayMs = 1000 - (Date.now() % 1000);
      clockTimer = setTimeout(() => {
        if (disposed) return;
        setNowMs(Date.now());
        scheduleClockTick();
      }, delayMs);
    };
    scheduleClockTick();
    // Stale-response guard: each refresh call gets a unique version.
    // When a newer call finishes first, older results are discarded.
    const IMMEDIATE_REFRESH_EVENTS = ["tui.session.select"];
    const COMPLETION_REFRESH_EVENTS = ["session.idle"];
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

      const results = new Map<QuotaProviderId, ProviderResult>();
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
        const items: QuotaLine[] = [];
        for (const provider of visibleProviders) {
          const r = results.get(provider.id);
          if (r === undefined) continue;
          // undefined means this provider was never set: not configured, skip it.
          if (r === null) {
            // null means the fetch is still running, show a spinner.
            items.push(headingLine(provider.label));
            items.push(detailTextLine("Refreshing…"));
          } else if (typeof r === "string") {
            items.push(headingLine(provider.label));
            items.push(detailTextLine(`Unavailable · ${r}`));
          } else {
            if (r[0]?.kind !== "heading") items.push(headingLine(provider.label));
            items.push(...r);
          }
          // string[] means data loaded successfully, display it.
        }
        return items;
      };

      setNowMs(Date.now());
      setLines(buildLines());
      // Show loading state immediately, then update per-provider as results arrive.

      try {
        // ── OpenCode Go ──
        if (goConfig && results.has("go")) {
          const result = await fetchGoDashboard(goConfig.workspaceId, goConfig.authCookie);
          if (currentVersion !== inFlightVersion) return;
          // Stale check: discard if a newer refresh already finished.
          if ("data" in result) {
            const fetchedAtMs = Date.now();
            setNowMs(fetchedAtMs);
            const d = result.data;
            const dataLines: QuotaLine[] = [];
            for (const [name, key] of [
              ["5h window", "rolling"],
              ["Weekly", "weekly"],
              ["Monthly", "monthly"],
            ] as const) {
              const w = d[key];
              if (w)
                dataLines.push(
                  windowLine(
                    name,
                    formatPercentQuota(w.used, w.remaining, displayMode),
                    w.resetInSec,
                    fetchedAtMs,
                  ),
                );
            }
            results.set("go", dataLines.length ? dataLines : [detailTextLine("No windows")]);
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
            const fetchedAtMs = Date.now();
            setNowMs(fetchedAtMs);
            const value = formatCountQuota(cp, displayMode);
            results.set(
              "copilot",
              cp.resetSec
                ? [windowLine("Monthly", value, cp.resetSec, fetchedAtMs)]
                : [detailTextLine(`Monthly · ${value}`)],
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
            results.set("openrouter", [
              detailTextLine(`Credits · ${formatCreditQuota(or, displayMode)}`),
            ]);
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
            const fetchedAtMs = Date.now();
            setNowMs(fetchedAtMs);
            const openAILines: QuotaLine[] = [];
            const sparkLines: QuotaLine[] = [];
            const addWindow = (
              targetLines: QuotaLine[],
              label: string,
              window: PercentWindow | undefined,
              paceWindowSeconds?: number,
            ) => {
              if (!window) return;
              targetLines.push(
                windowLine(
                  label,
                  formatUsedPercentQuota(window.usedPct, displayMode),
                  window.resetSec,
                  fetchedAtMs,
                ),
              );
              if (paceWindowSeconds) {
                targetLines.push(paceLine(window, paceWindowSeconds, fetchedAtMs));
              }
            };

            addWindow(openAILines, "5h", oa.hourly);
            addWindow(openAILines, "Weekly", oa.weekly, WEEK_SECONDS);
            addWindow(openAILines, "Code Review", oa.codeReview);

            for (const limit of oa.additionalRateLimits ?? []) {
              const status = formatOpenAIRateLimitStatus(limit);
              if (isOpenAISparkRateLimit(limit)) {
                addWindow(sparkLines, "5h", limit.primary);
                addWindow(
                  sparkLines,
                  "Weekly",
                  limit.secondary,
                  limit.secondary?.limitWindowSec || WEEK_SECONDS,
                );
                continue;
              }

              const primaryLabel = status ? `${limit.label} · ${status}` : limit.label;
              addWindow(openAILines, primaryLabel, limit.primary);
              addWindow(
                openAILines,
                limit.primary ? `${limit.label} Secondary` : `${primaryLabel} Secondary`,
                limit.secondary,
              );
            }

            if (oa.credits) openAILines.push(detailTextLine(`Credits · ${oa.credits}`));

            const dataLines: QuotaLine[] = [];
            if (openAILines.length) dataLines.push(headingLine("OpenAI"), ...openAILines);
            if (sparkLines.length) dataLines.push(headingLine("OpenAI Spark"), ...sparkLines);

            results.set("openai", dataLines.length ? dataLines : [detailTextLine("No windows")]);
          } else {
            results.set("openai", oa.error);
          }
          setLines(buildLines());
        }
      } catch (e) {
        if (disposed || currentVersion !== inFlightVersion) return;
        const msg = `Error: ${e instanceof Error ? e.message : String(e)}`;
        setLines([detailTextLine(msg)]);
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
      if (clockTimer) clearTimeout(clockTimer);
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
          return <View getLines={lines} getNowMs={nowMs} api={api} />;
        },
      },
    });
  },
};

export default plugin;
