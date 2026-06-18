import { describe, expect, it } from "vitest";
import {
  buildCodexUsageView,
  type CodexUsageSnapshot,
  formatResetCountdown,
  snapshotFromReading,
  USAGE_CRITICAL_PERCENT,
  USAGE_WARN_PERCENT,
  usageStateFor,
  usageStateTone,
} from "@/lib/agents/codex-usage";

const NOW = 1_700_000_000;
const HOUR = 3600;

describe("usageStateFor", () => {
  it("escalates ok -> warn -> critical at the thresholds", () => {
    expect(usageStateFor(0)).toBe("ok");
    expect(usageStateFor(USAGE_WARN_PERCENT - 0.01)).toBe("ok");
    expect(usageStateFor(USAGE_WARN_PERCENT)).toBe("warn");
    expect(usageStateFor(USAGE_CRITICAL_PERCENT - 0.01)).toBe("warn");
    expect(usageStateFor(USAGE_CRITICAL_PERCENT)).toBe("critical");
    expect(usageStateFor(100)).toBe("critical");
  });
});

describe("usageStateTone", () => {
  it("maps each state to a badge tone, escalating with severity", () => {
    expect(usageStateTone("unknown")).toBe("neutral");
    expect(usageStateTone("ok")).toBe("success");
    expect(usageStateTone("warn")).toBe("warning");
    expect(usageStateTone("critical")).toBe("destructive");
    expect(usageStateTone("blocked")).toBe("destructive");
  });
});

describe("formatResetCountdown", () => {
  it("returns null when no reset is pending", () => {
    expect(formatResetCountdown(null, NOW)).toBeNull();
    expect(formatResetCountdown(NOW, NOW)).toBeNull();
    expect(formatResetCountdown(NOW - 5, NOW)).toBeNull();
  });

  it("formats minutes, hours, and days", () => {
    expect(formatResetCountdown(NOW + 25 * 60, NOW)).toBe("25m");
    expect(formatResetCountdown(NOW + 2 * HOUR + 29 * 60, NOW)).toBe("2h 29m");
    expect(formatResetCountdown(NOW + 3 * HOUR, NOW)).toBe("3h");
    expect(formatResetCountdown(NOW + 4 * 24 * HOUR + 21 * HOUR, NOW)).toBe("4d 21h");
  });
});

describe("snapshotFromReading", () => {
  it("anchors relative resets to capture time", () => {
    const snapshot = snapshotFromReading(
      {
        primary: { usedPercent: 42.5, windowMinutes: 300, resetsInSeconds: 2 * HOUR },
        secondary: { usedPercent: 12, resetsInSeconds: 5 * 24 * HOUR },
      },
      NOW,
    );
    expect(snapshot).toEqual({
      capturedAt: NOW,
      primary: { usedPercent: 42.5, windowMinutes: 300, resetsAt: NOW + 2 * HOUR },
      secondary: { usedPercent: 12, windowMinutes: undefined, resetsAt: NOW + 5 * 24 * HOUR },
    });
  });

  it("omits resetsAt for a window with no reset offset", () => {
    const snapshot = snapshotFromReading({ primary: { usedPercent: 8 } }, NOW);
    expect(snapshot.primary?.resetsAt).toBeUndefined();
  });
});

describe("buildCodexUsageView", () => {
  function snapshot(over: Partial<CodexUsageSnapshot> = {}): CodexUsageSnapshot {
    return {
      capturedAt: NOW,
      primary: { usedPercent: 42, resetsAt: NOW + 2 * HOUR, windowMinutes: 300 },
      ...over,
    };
  }

  it("is unknown with neither a snapshot nor a latch", () => {
    expect(buildCodexUsageView({ now: NOW })).toMatchObject({ state: "unknown", tone: "neutral" });
  });

  it("reports ok with the busiest-window percent and the primary reset", () => {
    const view = buildCodexUsageView({
      snapshot: snapshot({
        primary: { usedPercent: 42, resetsAt: NOW + 2 * HOUR },
        secondary: { usedPercent: 12, resetsAt: NOW + 5 * 24 * HOUR },
      }),
      now: NOW,
    });
    expect(view.state).toBe("ok");
    expect(view.usedPercent).toBe(42);
    expect(view.resetsAt).toBe(NOW + 2 * HOUR);
    expect(view.secondary?.usedPercent).toBe(12);
  });

  it("takes the tier from the busiest window", () => {
    const view = buildCodexUsageView({
      snapshot: snapshot({
        primary: { usedPercent: 30, resetsAt: NOW + HOUR },
        secondary: { usedPercent: 91, resetsAt: NOW + 6 * 24 * HOUR },
      }),
      now: NOW,
    });
    expect(view.usedPercent).toBe(91);
    expect(view.state).toBe("critical");
    expect(view.tone).toBe("destructive");
  });

  it("folds an active latch into the blocked state, keeping the windows", () => {
    const view = buildCodexUsageView({
      snapshot: snapshot({ primary: { usedPercent: 10, resetsAt: NOW + HOUR } }),
      latchedUntil: NOW + 30 * 60,
      now: NOW,
    });
    expect(view.state).toBe("blocked");
    expect(view.blocked).toBe(true);
    expect(view.resetsAt).toBe(NOW + 30 * 60);
    expect(view.primary?.usedPercent).toBe(10);
  });

  it("degrades a snapshot whose short window has elapsed to unknown", () => {
    const view = buildCodexUsageView({
      snapshot: snapshot({ primary: { usedPercent: 80, resetsAt: NOW - 1 } }),
      now: NOW,
    });
    expect(view.state).toBe("unknown");
  });
});
