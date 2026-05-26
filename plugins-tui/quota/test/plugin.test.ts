import { beforeEach, describe, expect, it, vi } from "vitest";

import plugin, { formatResponsibleWeeklyUsage } from "../index.tsx";
import { createRefreshScheduler } from "../refresh-scheduler.ts";

describe("quota tui plugin", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });

  it("exposes a stable plugin contract", () => {
    expect(plugin.id).toBe("quota");
    expect(typeof plugin.tui).toBe("function");
  });

  it("schedules refreshes and stops after dispose", () => {
    const events = new Map<string, () => void>();
    const onRefresh = vi.fn();
    const scheduler = createRefreshScheduler({
      subscribe: (eventName, handler) => {
        events.set(eventName, handler);
        return () => events.delete(eventName);
      },
      onRefresh,
      immediateEvents: ["now"],
      completionEvents: ["later"],
    });

    events.get("now")?.();
    vi.advanceTimersByTime(300);
    expect(onRefresh).toHaveBeenCalledWith("now");

    events.get("later")?.();
    vi.advanceTimersByTime(549);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    expect(onRefresh).toHaveBeenCalledWith("later");

    scheduler.dispose();
    events.get("now")?.();
    vi.advanceTimersByTime(1000);
    expect(onRefresh).toHaveBeenCalledTimes(2);
  });

  it("formats weekly responsible usage pace", () => {
    expect(
      formatResponsibleWeeklyUsage({
        usedPct: 20,
        resetSec: 4 * 24 * 60 * 60,
      }),
    ).toBe("✓ ok · 23% below");

    expect(
      formatResponsibleWeeklyUsage({
        usedPct: 60,
        resetSec: 4 * 24 * 60 * 60,
      }),
    ).toBe("⚠ high · 17% over");
  });
});
