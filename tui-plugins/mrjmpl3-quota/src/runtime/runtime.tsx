/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from '@opencode-ai/plugin/tui';
import { createSignal } from 'solid-js';

import { useSlotVisibility, useClockTicker } from '@mrjmpl3/tui-kit/runtime';
import { usePolling } from '@mrjmpl3/tui-kit/data';

import type { QuotaLine } from '../domain/lines.ts';
import { detailTextLine, headingLine } from '../domain/lines.ts';
import { fetchProviderLines } from '../domain/provider-results.ts';
import type { GoConfig, ProviderFetchResult, ProviderResult } from '../domain/provider-results.ts';
import type { QuotaProviderId } from '../domain/types.ts';
import { createQuotaProviderCache } from '../infrastructure/cache.ts';
import { readGoConfig } from '../infrastructure/providers/go.ts';
import { View } from '../ui/view.tsx';
import { ALLOWED_VISIBLE_PROVIDER_IDS, DEFAULT_VISIBLE_PROVIDERS, inspectQuotaPluginOptions } from './options.ts';
import type { ProviderSpec } from '../domain/types.ts';
import { isRecord, slotSessionId } from '@mrjmpl3/tui-kit';

const TERMINAL_SESSION_STATUSES = new Set([
  'aborted',
  'cancelled',
  'canceled',
  'completed',
  'done',
  'error',
  'failed',
  'failure',
  'stopped',
  'success',
  'succeeded',
  'timeout',
  'timed_out',
]);
const TERMINAL_TASK_STATUSES = new Set(['cancelled', 'canceled', 'completed', 'done', 'error', 'failed', 'success']);
const PROVIDER_CACHE_INVALIDATION_SOURCES = new Set([
  'message.part.updated',
  'quota-window-expired',
  'session.error',
  'session.status',
]);

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;
const normalizedStatus = (value: unknown): string | undefined => asString(value)?.trim().toLowerCase();

const readStatus = (value: unknown): string | undefined => {
  if (!isRecord(value)) {
    return normalizedStatus(value);
  }

  return (
    normalizedStatus(value.status) ??
    readStatus(value.status) ??
    normalizedStatus(value.state) ??
    readStatus(value.state) ??
    normalizedStatus(value.phase) ??
    readStatus(value.phase)
  );
};

const readSessionStatus = (event: unknown): string | undefined => {
  if (!isRecord(event)) {
    return undefined;
  }

  return (
    readStatus(event.properties) ??
    readStatus(isRecord(event.properties) ? event.properties.info : undefined) ??
    readStatus(event.status) ??
    readStatus(event.state)
  );
};

export const isQuotaTerminalSessionEvent = (event: unknown): boolean => {
  const status = readSessionStatus(event);
  return status ? TERMINAL_SESSION_STATUSES.has(status) : false;
};

export const isQuotaTerminalTaskEvent = (event: unknown): boolean => {
  if (!isRecord(event) || !isRecord(event.properties) || !isRecord(event.properties.part)) {
    return false;
  }

  const { part } = event.properties;
  if (part.type !== 'tool' || part.tool !== 'task') {
    return false;
  }

  const status = readStatus(part.state) ?? readStatus(part.status);
  return status ? TERMINAL_TASK_STATUSES.has(status) : false;
};

const IMMEDIATE_REFRESH_EVENTS = ['tui.session.select'];
const COMPLETION_REFRESH_EVENTS = [
  'session.idle',
  'session.error',
  { name: 'session.status', shouldRefresh: isQuotaTerminalSessionEvent },
  { name: 'message.part.updated', shouldRefresh: isQuotaTerminalTaskEvent },
];

const hasExpiredQuotaLine = (items: readonly QuotaLine[], nowMs: number): boolean =>
  items.some((line) => (line.kind === 'window' || line.kind === 'pace') && line.resetAtMs <= nowMs);

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const shouldKeepDeferredRefreshTimer = (existingDueAtMs: number, nextDueAtMs: number): boolean => {
  return existingDueAtMs > 0 && existingDueAtMs <= nextDueAtMs;
};

const buildInvalidVisibleProvidersWarning = ({
  invalidVisibleProviderEntries,
  fellBackToDefaultVisibleProviders,
}: {
  invalidVisibleProviderEntries: readonly string[];
  fellBackToDefaultVisibleProviders: boolean;
}): string => {
  const fallbackMessage = fellBackToDefaultVisibleProviders
    ? ` Falling back to defaults: ${DEFAULT_VISIBLE_PROVIDERS.join(', ')}.`
    : '';

  return (
    `[quota] Ignoring invalid visibleProviders entries: ${invalidVisibleProviderEntries.join(', ')}. ` +
    `Allowed canonical provider ids: ${ALLOWED_VISIBLE_PROVIDER_IDS.join(', ')}.${fallbackMessage}`
  );
};

export const refreshQuotaProviders = async ({
  visibleProviders,
  results,
  goConfig,
  getCachedProviderLines,
  shouldContinue,
}: {
  visibleProviders: readonly ProviderSpec[];
  results: Map<QuotaProviderId, ProviderResult>;
  goConfig: GoConfig;
  getCachedProviderLines: (providerId: QuotaProviderId, goConfig: GoConfig) => Promise<ProviderFetchResult>;
  shouldContinue: () => boolean;
}): Promise<void> => {
  await Promise.allSettled(
    visibleProviders
      .filter((provider) => results.has(provider.id))
      .map(async (provider) => {
        let result: ProviderFetchResult;
        try {
          result = await getCachedProviderLines(provider.id, goConfig);
        } catch (error: unknown) {
          result = errorMessage(error);
        }
        if (!shouldContinue()) return;

        if (result === undefined) {
          results.delete(provider.id);
        } else {
          results.set(provider.id, result);
        }
      }),
  );
};

export const registerQuotaTui = async (api: TuiPluginApi, options: unknown): Promise<void> => {
  const { slots, event: evt, lifecycle } = api;
  const [lines, setLines] = createSignal<QuotaLine[]>([]);
  const [nowMs, setNowMs] = createSignal(Date.now());
  let currentSessionId = '';
  let inFlightVersion = 0;
  let refreshGeneration = 0;
  let disposed = false;
  // Slot-visibility gate provided by useSlotVisibility below.
  const { isVisible: slotActive, SlotProvider } = useSlotVisibility(api);


  const { options: resolvedOptions, diagnostics } = inspectQuotaPluginOptions(options);

  if (diagnostics.invalidVisibleProviderEntries.length > 0) {
    console.warn(buildInvalidVisibleProvidersWarning(diagnostics));
  }

  const {
    displayMode,
    visibleProviders,
    pollIntervalMs,
    minRefreshIntervalMs,
    providerCacheTtlMs: providerCacheTtlMilliseconds,
    providerErrorBackoffMs: providerErrorBackoffMilliseconds,
    experimentalOpenAIResetCredits,
  } = resolvedOptions;
  const goConfig = readGoConfig();
  const shouldDisplayGoProvider = Boolean(goConfig && goConfig.workspaces.length > 0);
  const expiryRefreshIntervalMs = Math.max(minRefreshIntervalMs, providerCacheTtlMilliseconds);
  const { providerCache, getCachedProviderLines, invalidateVisibleData } = createQuotaProviderCache({
    providerCacheTtlMilliseconds,
    providerErrorBackoffMilliseconds,
    fetchProviderLines: (providerId, goConfig) =>
      fetchProviderLines({ providerId, goConfig, displayMode, setNowMs, experimentalOpenAIResetCredits }),
  });
  let refreshPromise: Promise<void> | undefined;
  let pendingRefreshSource: string | undefined;
  let pendingCacheInvalidation = false;
  let pendingForce = false;
  let deferredRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let deferredRefreshDueAtMs = 0;
  let lastRefreshStartedAtMs = 0;
  let lastInvalidatingRefreshStartedAtMs = 0;
  let lastExpiryRefreshAtMs = 0;

  const shouldInvalidateProviderCache = (source?: string): boolean => {
    return source ? PROVIDER_CACHE_INVALIDATION_SOURCES.has(source) : false;
  };

  const queuePendingRefresh = (source?: string, invalidateProviderCache = false, force = false) => {
    pendingRefreshSource = pendingRefreshSource ?? source;
    pendingCacheInvalidation = pendingCacheInvalidation || invalidateProviderCache;
    pendingForce = pendingForce || force;
  };

  const clearDeferredRefreshTimer = () => {
    if (deferredRefreshTimer) {
      clearTimeout(deferredRefreshTimer);
    }
    deferredRefreshTimer = undefined;
    deferredRefreshDueAtMs = 0;
  };

  const buildLines = (results: Map<QuotaProviderId, ProviderResult>): QuotaLine[] => {
    const items: QuotaLine[] = [];
    for (const provider of visibleProviders) {
      const result = results.get(provider.id);
      if (result === undefined) continue;
      if (Array.isArray(result) && result.length === 0) continue;
      if (result === null) {
        items.push(headingLine(provider.label));
        items.push(detailTextLine('Refreshing…'));
      } else if (typeof result === 'string') {
        items.push(headingLine(provider.label));
        items.push(detailTextLine(result, 'error'));
      } else {
        if (result[0]?.kind !== 'heading') items.push(headingLine(provider.label));
        items.push(...result);
      }
    }
    return items;
  };

  const buildRefreshingLines = (): QuotaLine[] => {
    const refreshingResults = new Map<QuotaProviderId, ProviderResult>();

    for (const provider of visibleProviders) {
      if (provider.id === 'opencode-go' && !shouldDisplayGoProvider) continue;
      refreshingResults.set(provider.id, null);
    }

    return buildLines(refreshingResults);
  };

  const markVisibleDataStale = () => {
    refreshGeneration += 1;
    invalidateVisibleData();
    setLines(buildRefreshingLines());
  };

  const requestRefresh = (
    source?: string,
    force = false,
    invalidateProviderCache = shouldInvalidateProviderCache(source),
  ) => {
    if (disposed) return;
    if (invalidateProviderCache) {
      markVisibleDataStale();
    }
    if (refreshPromise) {
      queuePendingRefresh(source, invalidateProviderCache, force);
      return;
    }

    const now = Date.now();
    const lastRelevantRefreshStartedAtMs = invalidateProviderCache
      ? lastInvalidatingRefreshStartedAtMs
      : lastRefreshStartedAtMs;
    const elapsedMs = lastRelevantRefreshStartedAtMs > 0 ? now - lastRelevantRefreshStartedAtMs : Infinity;
    if (!force && elapsedMs < minRefreshIntervalMs) {
      scheduleDeferredRefresh(source, minRefreshIntervalMs - elapsedMs, invalidateProviderCache, force);
      return;
    }

    clearDeferredRefreshTimer();
    lastRefreshStartedAtMs = now;
    if (invalidateProviderCache) {
      lastInvalidatingRefreshStartedAtMs = now;
    }

    const promise = refresh(source);
    refreshPromise = promise;
    promise
      .finally(() => {
        refreshPromise = undefined;
        if (disposed || (!pendingRefreshSource && !pendingCacheInvalidation && !pendingForce)) return;
        const queuedSource = pendingRefreshSource;
        const queuedCacheInvalidation = pendingCacheInvalidation;
        const queuedForce = pendingForce;
        pendingRefreshSource = undefined;
        pendingCacheInvalidation = false;
        pendingForce = false;
        requestRefresh(queuedSource, queuedForce, queuedCacheInvalidation);
      })
      .catch((error: unknown) => {
        console.warn(`[quota] unexpected refresh failure: ${errorMessage(error)}`);
      });
  };

  const clockTickerDispose = useClockTicker({
    active: slotActive,
    onTick: (tickNowMs: number) => {
      // Preserve original behavior: skip clock updates when lines are empty.
      if (lines().length === 0) return;
      setNowMs(tickNowMs);
      if (hasExpiredQuotaLine(lines(), tickNowMs) && tickNowMs - lastExpiryRefreshAtMs >= expiryRefreshIntervalMs) {
        lastExpiryRefreshAtMs = tickNowMs;
        requestRefresh('quota-window-expired', true);
      }
    },
  });

  const refresh = async (_source?: string) => {
    if (disposed) return;
    const currentVersion = ++inFlightVersion;
    const currentGeneration = refreshGeneration;
    const results = new Map<QuotaProviderId, ProviderResult>();

    for (const provider of visibleProviders) {
      if (provider.id === 'opencode-go' && !shouldDisplayGoProvider) continue;
      results.set(provider.id, providerCache.get(provider.id)?.value ?? null);
    }

    setNowMs(Date.now());
    setLines(buildLines(results));

    await refreshQuotaProviders({
      visibleProviders,
      results,
      goConfig,
      getCachedProviderLines,
      shouldContinue: () => !disposed && currentVersion === inFlightVersion && currentGeneration === refreshGeneration,
    });
    // Apply all provider results in a single setLines update after the refresh
    // settles, instead of one setLines per provider, so the view re-renders
    // once per cycle rather than N times.
    if (!disposed && currentVersion === inFlightVersion && currentGeneration === refreshGeneration) {
      setLines(buildLines(results));
    }
  };

  const scheduleDeferredRefresh = (
    source?: string,
    delayMs: number = minRefreshIntervalMs,
    invalidateProviderCache = shouldInvalidateProviderCache(source),
    force = false,
  ) => {
    queuePendingRefresh(source, invalidateProviderCache, force);
    const dueAtMs = Date.now() + delayMs;

    if (deferredRefreshTimer && shouldKeepDeferredRefreshTimer(deferredRefreshDueAtMs, dueAtMs)) return;

    clearDeferredRefreshTimer();
    deferredRefreshDueAtMs = dueAtMs;
    deferredRefreshTimer = setTimeout(() => {
      clearDeferredRefreshTimer();
      const queuedSource = pendingRefreshSource;
      const queuedCacheInvalidation = pendingCacheInvalidation;
      const queuedForce = pendingForce;
      pendingRefreshSource = undefined;
      pendingCacheInvalidation = false;
      pendingForce = false;
      requestRefresh(queuedSource, queuedForce, queuedCacheInvalidation);
    }, delayMs);
  };

  // ── Polling via usePolling (replaces refresh-scheduler.ts poll interval) ────

  const pollResource = {
    refetch: () => requestRefresh('poll'),
    dispose: () => {},
    data: () => undefined as QuotaLine[] | undefined,
    loading: () => false,
    error: () => undefined,
  };

  const pollDispose =
    pollIntervalMs > 0
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ? usePolling({ resource: pollResource as any, intervalMs: pollIntervalMs, active: slotActive }).dispose
      : () => {};

  // ── Event subscriptions (replaces refresh-scheduler.ts event binding) ─────────

  const subscribeEvent = (
    event: { name: string; shouldRefresh?: (payload: unknown) => boolean },
    extraDelayMs: number,
  ): (() => void) => {
    const handler = (payload: unknown) => {
      if (event.shouldRefresh && !event.shouldRefresh(payload)) return;

      if (shouldInvalidateProviderCache(event.name)) {
        markVisibleDataStale();
      }

      // Default refresh delay is 300ms + extra delay from the scheduler.
      const totalDelayMs = 300 + extraDelayMs;
      scheduleDeferredRefresh(event.name, totalDelayMs, shouldInvalidateProviderCache(event.name));
    };

    switch (event.name) {
      case 'tui.session.select':
        return evt.on('tui.session.select', handler);
      case 'session.idle':
        return evt.on('session.idle', handler);
      case 'session.error':
        return evt.on('session.error', handler);
      case 'session.status':
        return evt.on('session.status', handler);
      case 'message.part.updated':
        return evt.on('message.part.updated', handler);
      default:
        return () => {};
    }
  };

  const normalizeEventSpec = (config: string | { name: string; shouldRefresh?: (payload: unknown) => boolean }) =>
    typeof config === 'string' ? { name: config } : config;

  const eventUnsubscribers: (() => void)[] = [];

  for (const eventConfig of IMMEDIATE_REFRESH_EVENTS) {
    const event = normalizeEventSpec(eventConfig);
    const unsubscribe = subscribeEvent(event, 0);
    eventUnsubscribers.push(unsubscribe);
  }

  for (const eventConfig of COMPLETION_REFRESH_EVENTS) {
    const event = normalizeEventSpec(eventConfig);
    const unsubscribe = subscribeEvent(event, 250);
    eventUnsubscribers.push(unsubscribe);
  }

  lifecycle.onDispose(() => {
    disposed = true;
    clockTickerDispose();
    if (deferredRefreshTimer) clearTimeout(deferredRefreshTimer);
    pollDispose();
    for (const unsubscribe of eventUnsubscribers) unsubscribe();
  });

  requestRefresh('initial', true);

  slots.register({
    order: 180,
    slots: {
      sidebar_content: (_ctx, slotInput) => {
        // Mark slot as visible and register cleanup via useSlotVisibility.
        SlotProvider(_ctx, slotInput);
        const sessionId = slotSessionId(slotInput);
        if (sessionId && sessionId !== currentSessionId) {
          currentSessionId = sessionId;
          requestRefresh(`session:${sessionId}`);
        }
        setNowMs(Date.now());
        return <View getLines={lines} getNowMs={nowMs} api={api} />;
      },
    },
  });
};
