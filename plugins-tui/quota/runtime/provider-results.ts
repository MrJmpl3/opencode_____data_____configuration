import {
  fetchCopilotQuota,
  fetchGoDashboard,
  fetchOpenAIQuota,
  fetchOpenRouterQuota,
  readGoConfig,
} from '../providers.js';
import {
  formatCountQuota,
  formatCreditQuota,
  formatOpenAIRateLimitStatus,
  formatPercentQuota,
  formatUsedPercentQuota,
  isOpenAISparkRateLimit,
  WEEK_SECONDS,
} from './format.js';
import { detailTextLine, headingLine, paceLine, windowLine } from './lines.js';
import type { PercentWindow, QuotaLine } from './lines.js';
import type { QuotaDisplayMode, QuotaProviderId } from './options.js';

export type GoConfig = ReturnType<typeof readGoConfig>;
export type CachedProviderValue = QuotaLine[] | string;
export type ProviderFetchResult = CachedProviderValue | undefined;
export type ProviderResult = QuotaLine[] | string | null;

export const fetchProviderLines = async (
  providerId: QuotaProviderId,
  goConfig: GoConfig,
  displayMode: QuotaDisplayMode,
  setNowMs: (nowMs: number) => void,
): Promise<ProviderFetchResult> => {
  if (providerId === 'go') {
    if (!goConfig) return undefined;
    const result = await fetchGoDashboard(goConfig.workspaceId, goConfig.authCookie);
    if (!('data' in result)) return result.error;

    const fetchedAtMs = Date.now();
    setNowMs(fetchedAtMs);
    const dataLines: QuotaLine[] = [];
    for (const [name, key] of [
      ['5h window', 'rolling'],
      ['Weekly', 'weekly'],
      ['Monthly', 'monthly'],
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
    return dataLines.length ? dataLines : [detailTextLine('No windows')];
  }

  if (providerId === 'copilot') {
    const cp = await fetchCopilotQuota();
    if (cp === null) return undefined;
    if ('error' in cp) return cp.error;

    const fetchedAtMs = Date.now();
    setNowMs(fetchedAtMs);
    const value = formatCountQuota(cp, displayMode);
    return cp.resetSec
      ? [windowLine('Monthly', value, cp.resetSec, fetchedAtMs)]
      : [detailTextLine(`Monthly · ${value}`)];
  }

  if (providerId === 'openrouter') {
    const openRouter = await fetchOpenRouterQuota();
    if (openRouter === null) return undefined;
    if ('error' in openRouter) return openRouter.error;
    return [detailTextLine(`Credits · ${formatCreditQuota(openRouter, displayMode)}`)];
  }

  const openAI = await fetchOpenAIQuota();
  if (openAI === null) return undefined;
  if ('error' in openAI) return openAI.error;

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
      windowLine(label, formatUsedPercentQuota(window.usedPct, displayMode), window.resetSec, fetchedAtMs),
    );
    if (paceWindowSeconds) {
      targetLines.push(paceLine(window, paceWindowSeconds, fetchedAtMs));
    }
  };

  addWindow(openAILines, '5h', openAI.hourly);
  addWindow(openAILines, 'Weekly', openAI.weekly, WEEK_SECONDS);
  addWindow(openAILines, 'Code Review', openAI.codeReview);

  for (const limit of openAI.additionalRateLimits ?? []) {
    const status = formatOpenAIRateLimitStatus(limit);
    if (isOpenAISparkRateLimit(limit)) {
      addWindow(sparkLines, '5h', limit.primary);
      addWindow(sparkLines, 'Weekly', limit.secondary, limit.secondary?.limitWindowSec || WEEK_SECONDS);
      continue;
    }

    const primaryLabel = status ? `${limit.label} · ${status}` : limit.label;
    addWindow(openAILines, primaryLabel, limit.primary);
    addWindow(openAILines, limit.primary ? `${limit.label} Secondary` : `${primaryLabel} Secondary`, limit.secondary);
  }

  if (openAI.credits) openAILines.push(detailTextLine(`Credits · ${openAI.credits}`));

  const dataLines: QuotaLine[] = [];
  if (openAILines.length) dataLines.push(headingLine('OpenAI'), ...openAILines);
  if (sparkLines.length) dataLines.push(headingLine('OpenAI Spark'), ...sparkLines);

  return dataLines.length ? dataLines : [detailTextLine('No windows')];
};
