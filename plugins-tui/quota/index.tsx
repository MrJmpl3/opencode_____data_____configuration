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
// Event-driven refresh with cache/backoff guards and an infrequent polling fallback.

type QuotaProviderId = "go" | "copilot" | "openrouter" | "openai";
type QuotaDisplayMode = "remaining" | "used";

type QuotaPluginOptions = {
  displayMode?: QuotaDisplayMode;
  visibleProviders?: readonly string[];
  pollIntervalMs?: number;
  minRefreshIntervalMs?: number;
  providerCacheTtlMs?: number;
  providerErrorBackoffMs?: number;
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
type CachedProviderValue = QuotaLine[] | string;
type ProviderFetchResult = CachedProviderValue | undefined;

type ProviderCacheEntry = {
  value?: CachedProviderValue;
  fetchedAtMs: number;
  cooldownUntilMs?: number;
  consecutiveErrors: number;
  inFlight?: Promise<ProviderFetchResult>;
};

const PROVIDER_SPECS: readonly ProviderSpec[] = [
  { id: "go", label: "OpenCode Go" },
  { id: "copilot", label: "GitHub Copilot" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "openai", label: "OpenAI" },
];

const DEFAULT_VISIBLE_PROVIDERS: readonly QuotaProviderId[] = ["go", "copilot", "openrouter"];
const DEFAULT_POLL_INTERVAL_MS = 10 * 60_000;
const DEFAULT_MIN_REFRESH_INTERVAL_MS = 120_000;
const DEFAULT_PROVIDER_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_PROVIDER_ERROR_BACKOFF_MS = 15 * 60_000;
const MIN_SAFE_REFRESH_INTERVAL_MS = 60_000;
const MIN_SAFE_CACHE_TTL_MS = 60_000;
const MAX_PROVIDER_BACKOFF_MS = 60 * 60_000;

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

const getNumberOption = (
  options: unknown,
  key: keyof QuotaPluginOptions,
  fallback: number,
  minimum: number,
  allowZero = false,
): number => {
  if (!options || typeof options !== "object") return fallback;
  const value = (options as QuotaPluginOptions)[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (allowZero && value === 0) return 0;
  return Math.max(minimum, value);
};

export const isQuotaRateLimitError = (message: string): boolean => {
  return /\b(429|403)\b|rate.?limit|too many requests|temporar(?:y|ily)|secondary rate/i.test(
    message,
  );
};

export const retryAfterMsFromMessage = (message: string): number => {
  const retryAfterMs = parseBackoffDelayMs(message, /retry[- ]after[:=]?\s*([^;\n]+)/i);
  if (retryAfterMs > 0) return retryAfterMs;

  return parseBackoffResetMs(message, /rate[- ]limit[- ]reset[:=]?\s*([^;\n]+)/i);
};

const parseBackoffDelayMs = (message: string, pattern: RegExp): number => {
  const match = message.match(pattern);
  if (!match) return 0;
  const rawValue = match[1].trim();
  const numericValue = rawValue.match(/^\d+(?:\.\d+)?/)?.[0];
  const seconds = numericValue ? Number(numericValue) : Number.NaN;
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;

  const retryAtMs = Date.parse(rawValue);
  if (!Number.isNaN(retryAtMs)) return Math.max(0, retryAtMs - Date.now());

  return 0;
};

const parseBackoffResetMs = (message: string, pattern: RegExp): number => {
  const match = message.match(pattern);
  if (!match) return 0;
  const rawValue = match[1].trim();
  const numericValue = rawValue.match(/^\d+(?:\.\d+)?/)?.[0];
  const resetValue = numericValue ? Number(numericValue) : Number.NaN;
  if (Number.isFinite(resetValue) && resetValue > 0) {
    const resetAtMs =
      resetValue > 1_000_000_000 ? resetValue * 1000 : Date.now() + resetValue * 1000;
    return Math.max(0, resetAtMs - Date.now());
  }

  const retryAtMs = Date.parse(rawValue);
  if (!Number.isNaN(retryAtMs)) return Math.max(0, retryAtMs - Date.now());

  return 0;
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
  const hasTotal = typeof total === "number" && Number.isFinite(total) && total > 0;

  const value =
    displayMode === "used"
      ? (used ?? (hasTotal && typeof remaining === "number" ? total - remaining : undefined))
      : (remaining ?? (hasTotal && typeof used === "number" ? total - used : undefined));

  if (typeof value !== "number" || !Number.isFinite(value)) return data.text;
  return `${Math.max(0, value).toFixed(0)} pts`;
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
    const pollIntervalMs = getNumberOption(
      options,
      "pollIntervalMs",
      DEFAULT_POLL_INTERVAL_MS,
      MIN_SAFE_REFRESH_INTERVAL_MS,
      true,
    );
    const minRefreshIntervalMs = getNumberOption(
      options,
      "minRefreshIntervalMs",
      DEFAULT_MIN_REFRESH_INTERVAL_MS,
      MIN_SAFE_REFRESH_INTERVAL_MS,
    );
    const providerCacheTtlMs = getNumberOption(
      options,
      "providerCacheTtlMs",
      DEFAULT_PROVIDER_CACHE_TTL_MS,
      MIN_SAFE_CACHE_TTL_MS,
    );
    const providerErrorBackoffMs = getNumberOption(
      options,
      "providerErrorBackoffMs",
      DEFAULT_PROVIDER_ERROR_BACKOFF_MS,
      MIN_SAFE_CACHE_TTL_MS,
    );
    const providerCache = new Map<QuotaProviderId, ProviderCacheEntry>();
    let refreshPromise: Promise<void> | undefined;
    let pendingRefreshSource: string | undefined;
    let deferredRefreshTimer: ReturnType<typeof setTimeout> | undefined;
    let lastRefreshStartedAtMs = 0;
    // Session select triggers immediate refresh.
    // Session idle (post-LLM-call) triggers a delayed refresh with staggered timers.

    const getErrorCooldownMs = (message: string, attempts: number): number => {
      const retryAfterMs = retryAfterMsFromMessage(message);
      const baseMs = isQuotaRateLimitError(message) ? providerErrorBackoffMs : providerCacheTtlMs;
      const multipliedMs = baseMs * Math.min(4, Math.max(1, attempts));
      return Math.max(retryAfterMs, Math.min(multipliedMs, MAX_PROVIDER_BACKOFF_MS));
    };

    const fetchProviderLines = async (
      providerId: QuotaProviderId,
      goConfig: ReturnType<typeof readGoConfig>,
    ): Promise<ProviderFetchResult> => {
      if (providerId === "go") {
        if (!goConfig) return undefined;
        const result = await fetchGoDashboard(goConfig.workspaceId, goConfig.authCookie);
        if (!("data" in result)) return result.error;

        const fetchedAtMs = Date.now();
        setNowMs(fetchedAtMs);
        const dataLines: QuotaLine[] = [];
        for (const [name, key] of [
          ["5h window", "rolling"],
          ["Weekly", "weekly"],
          ["Monthly", "monthly"],
        ] as const) {
          const window = result.data[key];
          if (!window) continue;
          dataLines.push(
            windowLine(
              name,
              formatPercentQuota(window.used, window.remaining, displayMode),
              window.resetInSec,
              fetchedAtMs,
            ),
          );
        }
        return dataLines.length ? dataLines : [detailTextLine("No windows")];
      }

      if (providerId === "copilot") {
        const cp = await fetchCopilotQuota();
        if (cp === null) return undefined;
        if ("error" in cp) return cp.error;

        const fetchedAtMs = Date.now();
        setNowMs(fetchedAtMs);
        const value = formatCountQuota(cp, displayMode);
        return cp.resetSec
          ? [windowLine("Monthly", value, cp.resetSec, fetchedAtMs)]
          : [detailTextLine(`Monthly · ${value}`)];
      }

      if (providerId === "openrouter") {
        const openRouter = await fetchOpenRouterQuota();
        if (openRouter === null) return undefined;
        if ("error" in openRouter) return openRouter.error;
        return [detailTextLine(`Credits · ${formatCreditQuota(openRouter, displayMode)}`)];
      }

      const openAI = await fetchOpenAIQuota();
      if (openAI === null) return undefined;
      if ("error" in openAI) return openAI.error;

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

      addWindow(openAILines, "5h", openAI.hourly);
      addWindow(openAILines, "Weekly", openAI.weekly, WEEK_SECONDS);
      addWindow(openAILines, "Code Review", openAI.codeReview);

      for (const limit of openAI.additionalRateLimits ?? []) {
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

      if (openAI.credits) openAILines.push(detailTextLine(`Credits · ${openAI.credits}`));

      const dataLines: QuotaLine[] = [];
      if (openAILines.length) dataLines.push(headingLine("OpenAI"), ...openAILines);
      if (sparkLines.length) dataLines.push(headingLine("OpenAI Spark"), ...sparkLines);

      return dataLines.length ? dataLines : [detailTextLine("No windows")];
    };

    const cacheProviderResult = (
      providerId: QuotaProviderId,
      value: ProviderFetchResult,
    ): ProviderFetchResult => {
      if (value === undefined) {
        providerCache.delete(providerId);
        return undefined;
      }

      const now = Date.now();
      const previous = providerCache.get(providerId);
      const consecutiveErrors =
        typeof value === "string" ? (previous?.consecutiveErrors ?? 0) + 1 : 0;
      providerCache.set(providerId, {
        value,
        fetchedAtMs: now,
        consecutiveErrors,
        cooldownUntilMs:
          typeof value === "string"
            ? now + getErrorCooldownMs(value, consecutiveErrors)
            : undefined,
      });
      return value;
    };

    const getCachedProviderLines = async (
      providerId: QuotaProviderId,
      goConfig: ReturnType<typeof readGoConfig>,
    ): Promise<ProviderFetchResult> => {
      const now = Date.now();
      const entry = providerCache.get(providerId);
      if (entry?.inFlight) return entry.inFlight;
      if (entry?.cooldownUntilMs && entry.cooldownUntilMs > now) {
        return (
          entry.value ??
          `Refresh paused · retry in ${fmtDuration(Math.ceil((entry.cooldownUntilMs - now) / 1000))}`
        );
      }
      if (entry?.value !== undefined && now - entry.fetchedAtMs < providerCacheTtlMs) {
        return entry.value;
      }

      let request: Promise<ProviderFetchResult>;
      request = fetchProviderLines(providerId, goConfig)
        .then((value) => cacheProviderResult(providerId, value))
        .catch((error: unknown) => {
          const message = `Error: ${error instanceof Error ? error.message : String(error)}`;
          return cacheProviderResult(providerId, message);
        });

      providerCache.set(providerId, {
        value: entry?.value,
        fetchedAtMs: entry?.fetchedAtMs ?? 0,
        cooldownUntilMs: entry?.cooldownUntilMs,
        consecutiveErrors: entry?.consecutiveErrors ?? 0,
        inFlight: request,
      });

      return request;
    };

    // --- refresh() renders cached data first, then fetches providers sequentially ---
    // Sequential requests plus cache/backoff guards avoid bursts that can trigger bans.
    const refresh = async (_source?: string) => {
      if (disposed) return;
      const currentVersion = ++inFlightVersion;
      const results = new Map<QuotaProviderId, ProviderResult>();
      const goConfig = readGoConfig();

      for (const provider of visibleProviders) {
        if (provider.id === "go" && !goConfig) continue;
        results.set(provider.id, providerCache.get(provider.id)?.value ?? null);
      }

      const buildLines = () => {
        const items: QuotaLine[] = [];
        for (const provider of visibleProviders) {
          const result = results.get(provider.id);
          if (result === undefined) continue;
          if (result === null) {
            items.push(headingLine(provider.label));
            items.push(detailTextLine("Refreshing…"));
          } else if (typeof result === "string") {
            items.push(headingLine(provider.label));
            items.push(detailTextLine(`Unavailable · ${result}`));
          } else {
            if (result[0]?.kind !== "heading") items.push(headingLine(provider.label));
            items.push(...result);
          }
        }
        return items;
      };

      setNowMs(Date.now());
      setLines(buildLines());

      for (const provider of visibleProviders) {
        if (!results.has(provider.id)) continue;
        const result = await getCachedProviderLines(provider.id, goConfig);
        if (disposed || currentVersion !== inFlightVersion) return;
        if (result === undefined) {
          results.delete(provider.id);
        } else {
          results.set(provider.id, result);
        }
        setLines(buildLines());
      }
    };
    const scheduleDeferredRefresh = (source?: string, delayMs: number = minRefreshIntervalMs) => {
      pendingRefreshSource = source ?? pendingRefreshSource;
      if (deferredRefreshTimer) return;
      deferredRefreshTimer = setTimeout(() => {
        deferredRefreshTimer = undefined;
        const queuedSource = pendingRefreshSource;
        pendingRefreshSource = undefined;
        requestRefresh(queuedSource);
      }, delayMs);
    };

    const requestRefresh = (source?: string, force = false) => {
      if (disposed) return;
      if (refreshPromise) {
        pendingRefreshSource = source ?? pendingRefreshSource;
        return;
      }

      const now = Date.now();
      const elapsedMs = lastRefreshStartedAtMs > 0 ? now - lastRefreshStartedAtMs : Infinity;
      if (!force && elapsedMs < minRefreshIntervalMs) {
        scheduleDeferredRefresh(source, minRefreshIntervalMs - elapsedMs);
        return;
      }

      lastRefreshStartedAtMs = now;
      const promise = refresh(source);
      refreshPromise = promise;
      promise
        .finally(() => {
          refreshPromise = undefined;
          if (disposed || !pendingRefreshSource) return;
          const queuedSource = pendingRefreshSource;
          pendingRefreshSource = undefined;
          requestRefresh(queuedSource);
        })
        .catch(() => {});
    };

    // --- Event subscriptions: refresh on session select and idle ---
    const scheduler = createRefreshScheduler({
      subscribe: (eventName, handler) => evt.on(eventName as any, handler),
      onRefresh: requestRefresh,
      immediateEvents: IMMEDIATE_REFRESH_EVENTS,
      completionEvents: COMPLETION_REFRESH_EVENTS,
      pollIntervalMs,
    });
    lifecycle.onDispose(() => {
      disposed = true;
      if (clockTimer) clearTimeout(clockTimer);
      if (deferredRefreshTimer) clearTimeout(deferredRefreshTimer);
      scheduler.dispose();
    });
    // Fire-and-forget initial fetch (don't block slot registration)
    requestRefresh("initial", true);

    slots.register({
      order: 180,
      slots: {
        sidebar_content: (_ctx: any, slotInput: any) => {
          const sid = (slotInput as any)?.session_id ?? "";
          if (sid && sid !== currentSessionId) {
            currentSessionId = sid;
            requestRefresh(`session:${sid}`);
          }
          return <View getLines={lines} getNowMs={nowMs} api={api} />;
        },
      },
    });
  },
};

export default plugin;
