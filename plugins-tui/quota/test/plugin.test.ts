import { beforeEach, describe, expect, it, vi } from "vitest";

import plugin, {
  formatResponsibleWeeklyUsage,
  isQuotaRateLimitError,
  retryAfterMsFromMessage,
} from "../index.tsx";
import { createRefreshScheduler } from "../refresh-scheduler.ts";
import { fmtDuration, parseAdditionalRateLimits } from "../providers.ts";

describe("quota tui plugin", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });

  it("exposes a stable plugin contract", () => {
    expect(plugin.id).toBe("quota");
    expect(typeof plugin.tui).toBe("function");
  });

  it("coalesces repeated immediate refresh events before execution", () => {
    const events = new Map<string, () => void>();
    const onRefresh = vi.fn();
    const scheduler = createRefreshScheduler({
      subscribe: (eventName, handler) => {
        events.set(eventName, handler);
        return () => events.delete(eventName);
      },
      onRefresh,
      immediateEvents: ["now"],
      completionEvents: [],
      pollIntervalMs: 0,
      refreshDelayMs: 250,
    });

    events.get("now")?.();
    events.get("now")?.();
    events.get("now")?.();
    events.get("now")?.();
    vi.advanceTimersByTime(249);
    expect(onRefresh).toHaveBeenCalledTimes(0);

    events.get("now")?.();
    vi.advanceTimersByTime(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledWith("now");

    scheduler.dispose();
  });

  it("recognizes rate-limit errors and ignores plain parse errors", () => {
    expect(isQuotaRateLimitError("Request failed with status code 429: Too Many Requests")).toBe(
      true,
    );
    expect(isQuotaRateLimitError("Rate limit exceeded while processing request")).toBe(true);
    expect(
      isQuotaRateLimitError("Cannot parse response: unexpected token in JSON at position 1"),
    ).toBe(false);
  });

  it("honors retry-after details even when an error body follows", () => {
    expect(retryAfterMsFromMessage("OpenAI HTTP 429; retry-after=3600; body: slow down")).toBe(
      3_600_000,
    );
    expect(retryAfterMsFromMessage("OpenRouter HTTP 429; retry-after 120: slow down")).toBe(
      120_000,
    );
  });

  it("formats weekly responsible usage pace", () => {
    expect(
      formatResponsibleWeeklyUsage({
        usedPct: 20,
        resetSec: 4 * 24 * 60 * 60,
      }),
    ).toBe("✓ ok · 22.86% below");

    expect(
      formatResponsibleWeeklyUsage({
        usedPct: 60,
        resetSec: 4 * 24 * 60 * 60,
      }),
    ).toBe("⚠ high · 17.14% over");
  });

  it("formats durations including minutes and seconds", () => {
    expect(fmtDuration(6 * 86400 + 23 * 3600 + 12 * 60 + 34)).toBe("6d 23h 12m 34s");
    expect(fmtDuration(75)).toBe("1m 15s");
  });

  it("parses Codex Spark additional rate limit", () => {
    const limits = parseAdditionalRateLimits([
      {
        limit_name: "GPT-5.3-Codex-Spark",
        metered_feature: "...",
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: {
            used_percent: 12.5,
            reset_after_seconds: 3600,
            reset_at: 1234567890,
            limit_window_seconds: 18000,
          },
          secondary_window: {
            used_percent: 25,
            reset_after_seconds: 7200,
            reset_at: 1234567890,
            limit_window_seconds: 604800,
          },
        },
      },
    ]);

    expect(limits).toHaveLength(1);
    expect(limits[0]).toMatchObject({
      label: "Codex Spark",
      allowed: true,
      limitReached: false,
      primary: {
        usedPct: 12.5,
        resetSec: 3600,
        limitWindowSec: 18000,
      },
      secondary: {
        usedPct: 25,
        resetSec: 7200,
        limitWindowSec: 604800,
      },
    });
  });
});
