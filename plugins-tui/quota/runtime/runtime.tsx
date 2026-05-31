/** @jsxImportSource @opentui/solid */
import { createSignal } from 'solid-js';
import type { TuiPluginApi } from '@opencode-ai/plugin/tui';

import { readGoConfig } from '../providers.js';
import { createRefreshScheduler } from './refresh-scheduler.js';
import { createQuotaProviderCache } from './cache.js';
import { fetchProviderLines } from './provider-results.js';
import type { ProviderResult } from './provider-results.js';
import { detailTextLine, headingLine } from './lines.js';
import type { QuotaLine } from './lines.js';
import {
  DEFAULT_MIN_REFRESH_INTERVAL_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_PROVIDER_CACHE_TTL_MS,
  DEFAULT_PROVIDER_ERROR_BACKOFF_MS,
  getDisplayModeSetting,
  getNumberOption,
  getVisibleProviders,
  MIN_SAFE_CACHE_TTL_MS,
  MIN_SAFE_REFRESH_INTERVAL_MS,
} from './options.js';
import type { QuotaProviderId } from './options.js';
import { View } from './view.js';

const IMMEDIATE_REFRESH_EVENTS = ['tui.session.select'];
const COMPLETION_REFRESH_EVENTS = ['session.idle'];

const hasExpiredQuotaLine = (items: readonly QuotaLine[], nowMs: number): boolean =>
  items.some((line) => (line.kind === 'window' || line.kind === 'pace') && line.resetAtMs <= nowMs);

export const registerQuotaTui = async (api: TuiPluginApi, options: unknown): Promise<void> => {
  const { slots, event: evt, lifecycle } = api;
  const [lines, setLines] = createSignal<QuotaLine[]>([]);
  const [nowMs, setNowMs] = createSignal(Date.now());
  let currentSessionId = '';
  let inFlightVersion = 0;
  let disposed = false;
  let clockTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleClockTick = () => {
    const delayMs = 1000 - (Date.now() % 1000);
    clockTimer = setTimeout(() => {
      if (disposed) return;
      const tickNowMs = Date.now();
      setNowMs(tickNowMs);
      if (hasExpiredQuotaLine(lines(), tickNowMs) && tickNowMs - lastExpiryRefreshAtMs >= expiryRefreshIntervalMs) {
        lastExpiryRefreshAtMs = tickNowMs;
        providerCache.clear();
        requestRefresh('quota-window-expired', true);
      }
      scheduleClockTick();
    }, delayMs);
  };

  const displayMode = getDisplayModeSetting(options);
  const visibleProviders = getVisibleProviders(options);
  const pollIntervalMs = getNumberOption(
    options,
    'pollIntervalMs',
    DEFAULT_POLL_INTERVAL_MS,
    MIN_SAFE_REFRESH_INTERVAL_MS,
    true,
  );
  const minRefreshIntervalMs = getNumberOption(
    options,
    'minRefreshIntervalMs',
    DEFAULT_MIN_REFRESH_INTERVAL_MS,
    MIN_SAFE_REFRESH_INTERVAL_MS,
  );
  const providerCacheTtlMs = getNumberOption(
    options,
    'providerCacheTtlMs',
    DEFAULT_PROVIDER_CACHE_TTL_MS,
    MIN_SAFE_CACHE_TTL_MS,
  );
  const providerErrorBackoffMs = getNumberOption(
    options,
    'providerErrorBackoffMs',
    DEFAULT_PROVIDER_ERROR_BACKOFF_MS,
    MIN_SAFE_CACHE_TTL_MS,
  );
  const expiryRefreshIntervalMs = Math.max(minRefreshIntervalMs, providerCacheTtlMs);
  const { providerCache, getCachedProviderLines } = createQuotaProviderCache({
    providerCacheTtlMs,
    providerErrorBackoffMs,
    fetchProviderLines: (providerId, goConfig) => fetchProviderLines(providerId, goConfig, displayMode, setNowMs),
  });
  scheduleClockTick();
  let refreshPromise: Promise<void> | undefined;
  let pendingRefreshSource: string | undefined;
  let deferredRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let lastRefreshStartedAtMs = 0;
  let lastExpiryRefreshAtMs = 0;

  const refresh = async (_source?: string) => {
    if (disposed) return;
    const currentVersion = ++inFlightVersion;
    const results = new Map<QuotaProviderId, ProviderResult>();
    const goConfig = readGoConfig();

    for (const provider of visibleProviders) {
      if (provider.id === 'go' && !goConfig) continue;
      results.set(provider.id, providerCache.get(provider.id)?.value ?? null);
    }

    const buildLines = () => {
      const items: QuotaLine[] = [];
      for (const provider of visibleProviders) {
        const result = results.get(provider.id);
        if (result === undefined) continue;
        if (result === null) {
          items.push(headingLine(provider.label));
          items.push(detailTextLine('Refreshing…'));
        } else if (typeof result === 'string') {
          items.push(headingLine(provider.label));
          items.push(detailTextLine(`Unavailable · ${result}`));
        } else {
          if (result[0]?.kind !== 'heading') items.push(headingLine(provider.label));
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
      .catch((error: unknown) => {
        const ignoredError = error;
        void ignoredError;
      });
  };

  const scheduler = createRefreshScheduler({
    subscribe: (eventName, handler) => evt.on(eventName as never, handler),
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

  requestRefresh('initial', true);

  slots.register({
    order: 180,
    slots: {
      sidebar_content: (_ctx, slotInput) => {
        const sid = slotInput.session_id ?? '';
        if (sid && sid !== currentSessionId) {
          currentSessionId = sid;
          requestRefresh(`session:${sid}`);
        }
        return <View getLines={lines} getNowMs={nowMs} api={api} />;
      },
    },
  });
};
