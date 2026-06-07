/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from '@opencode-ai/plugin/tui';
import { createSignal } from 'solid-js';

import type { QuotaLine } from '../domain/lines.ts';
import { detailTextLine, headingLine } from '../domain/lines.ts';
import { fetchProviderLines } from '../domain/provider-results.ts';
import type { GoConfig, ProviderFetchResult, ProviderResult } from '../domain/provider-results.ts';
import type { QuotaProviderId } from '../domain/types.ts';
import { createQuotaProviderCache } from '../infrastructure/cache.ts';
import { readGoConfig } from '../infrastructure/providers/go.ts';
import { View } from '../ui/view.tsx';
import { createRefreshScheduler } from './refresh-scheduler.ts';
import { resolveQuotaPluginOptions } from './options.ts';
import type { ProviderSpec } from '../domain/types.ts';
import { slotSessionId } from './session.ts';

const IMMEDIATE_REFRESH_EVENTS = ['tui.session.select'];
const COMPLETION_REFRESH_EVENTS = ['session.idle'];

const hasExpiredQuotaLine = (items: readonly QuotaLine[], nowMs: number): boolean =>
  items.some((line) => (line.kind === 'window' || line.kind === 'pace') && line.resetAtMs <= nowMs);

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const refreshQuotaProviders = async ({
  visibleProviders,
  results,
  goConfig,
  getCachedProviderLines,
  shouldContinue,
  onUpdate,
}: {
  visibleProviders: readonly ProviderSpec[];
  results: Map<QuotaProviderId, ProviderResult>;
  goConfig: GoConfig;
  getCachedProviderLines: (providerId: QuotaProviderId, goConfig: GoConfig) => Promise<ProviderFetchResult>;
  shouldContinue: () => boolean;
  onUpdate: () => void;
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

        onUpdate();
      }),
  );
};

export const registerQuotaTui = async (api: TuiPluginApi, options: unknown): Promise<void> => {
  const { slots, event: evt, lifecycle } = api;
  const [lines, setLines] = createSignal<QuotaLine[]>([]);
  const [nowMs, setNowMs] = createSignal(Date.now());
  let currentSessionId = '';
  let inFlightVersion = 0;
  let disposed = false;
  let clockTimer: ReturnType<typeof setTimeout> | undefined;

  const {
    displayMode,
    visibleProviders,
    pollIntervalMs,
    minRefreshIntervalMs,
    providerCacheTtlMs,
    providerErrorBackoffMs,
  } = resolveQuotaPluginOptions(options);
  const expiryRefreshIntervalMs = Math.max(minRefreshIntervalMs, providerCacheTtlMs);
  const { providerCache, getCachedProviderLines } = createQuotaProviderCache({
    providerCacheTtlMs,
    providerErrorBackoffMs,
    fetchProviderLines: (providerId, goConfig) => fetchProviderLines(providerId, goConfig, displayMode, setNowMs),
  });
  let refreshPromise: Promise<void> | undefined;
  let pendingRefreshSource: string | undefined;
  let deferredRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let lastRefreshStartedAtMs = 0;
  let lastExpiryRefreshAtMs = 0;

  const buildLines = (results: Map<QuotaProviderId, ProviderResult>): QuotaLine[] => {
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
        console.warn(`[quota] unexpected refresh failure: ${errorMessage(error)}`);
      });
  };

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

  const refresh = async (_source?: string) => {
    if (disposed) return;
    const currentVersion = ++inFlightVersion;
    const results = new Map<QuotaProviderId, ProviderResult>();
    const goConfig = readGoConfig();

    for (const provider of visibleProviders) {
      if (provider.id === 'go' && !goConfig) continue;
      results.set(provider.id, providerCache.get(provider.id)?.value ?? null);
    }

    setNowMs(Date.now());
    setLines(buildLines(results));

    await refreshQuotaProviders({
      visibleProviders,
      results,
      goConfig,
      getCachedProviderLines,
      shouldContinue: () => !disposed && currentVersion === inFlightVersion,
      onUpdate: () => setLines(buildLines(results)),
    });
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

  scheduleClockTick();

  const scheduler = createRefreshScheduler({
    subscribe: (eventName, handler) => {
      if (eventName === 'tui.session.select') return evt.on('tui.session.select', handler);
      if (eventName === 'session.idle') return evt.on('session.idle', handler);

      return () => {};
    },
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
        const sessionId = slotSessionId(slotInput);
        if (sessionId && sessionId !== currentSessionId) {
          currentSessionId = sessionId;
          requestRefresh(`session:${sessionId}`);
        }
        return <View getLines={lines} getNowMs={nowMs} api={api} />;
      },
    },
  });
};
