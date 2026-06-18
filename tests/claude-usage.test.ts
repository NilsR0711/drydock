import { describe, expect, it } from "vitest";
import {
  deriveClaudeUsageView,
  formatResetCountdown,
  normalizeUsageStatus,
  readingFromRateLimit,
} from "@/lib/agents/claude-usage";

const NOW = 1_750_000_000;
const HOUR = 3600;

describe("normalizeUsageStatus", () => {
  it("maps the CLI's allowed status to ok", () => {
    expect(normalizeUsageStatus("allowed")).toBe("ok");
  });

  it("maps warning statuses to warning", () => {
    expect(normalizeUsageStatus("allowed_warning")).toBe("warning");
    expect(normalizeUsageStatus("warning")).toBe("warning");
  });

  it("maps rejected/blocked statuses to blocked", () => {
    expect(normalizeUsageStatus("rejected")).toBe("blocked");
    expect(normalizeUsageStatus("blocked")).toBe("blocked");
  });

  it("is case-insensitive", () => {
    expect(normalizeUsageStatus("ALLOWED")).toBe("ok");
  });

  it("returns undefined for an unrecognized or missing status", () => {
    expect(normalizeUsageStatus("something_new")).toBeUndefined();
    expect(normalizeUsageStatus(undefined)).toBeUndefined();
  });
});

describe("readingFromRateLimit", () => {
  it("builds a reading from a recognized rate_limit_info", () => {
    const reading = readingFromRateLimit(
      { status: "allowed", resetsAt: NOW + HOUR, rateLimitType: "five_hour" },
      NOW,
    );
    expect(reading).toEqual({
      status: "ok",
      windowType: "five_hour",
      resetsAt: NOW + HOUR,
      capturedAt: NOW,
    });
  });

  it("falls back to ok when only a reset epoch is present", () => {
    const reading = readingFromRateLimit({ resetsAt: NOW + HOUR }, NOW);
    expect(reading).toMatchObject({ status: "ok", resetsAt: NOW + HOUR, windowType: "unknown" });
  });

  it("returns undefined when there is no usable signal", () => {
    expect(readingFromRateLimit(undefined, NOW)).toBeUndefined();
    expect(readingFromRateLimit({}, NOW)).toBeUndefined();
    expect(readingFromRateLimit({ status: "mystery" }, NOW)).toBeUndefined();
  });
});

describe("deriveClaudeUsageView", () => {
  it("renders unknown when there is no reading and no latch", () => {
    const v = deriveClaudeUsageView({ now: NOW });
    expect(v.state).toBe("unknown");
    expect(v.tone).toBe("neutral");
    expect(v.blocked).toBe(false);
    expect(v.resetsAt).toBeNull();
  });

  it("escalates tone with the reading status", () => {
    const base = { windowType: "five_hour", resetsAt: NOW + HOUR, capturedAt: NOW };
    expect(deriveClaudeUsageView({ reading: { ...base, status: "ok" }, now: NOW }).tone).toBe(
      "success",
    );
    expect(deriveClaudeUsageView({ reading: { ...base, status: "warning" }, now: NOW }).tone).toBe(
      "warning",
    );
    expect(deriveClaudeUsageView({ reading: { ...base, status: "blocked" }, now: NOW }).tone).toBe(
      "destructive",
    );
  });

  it("folds an active provider latch into the blocked/terminal state", () => {
    const v = deriveClaudeUsageView({
      reading: { status: "ok", windowType: "five_hour", resetsAt: NOW + HOUR, capturedAt: NOW },
      latchedUntil: NOW + 2 * HOUR,
      now: NOW,
    });
    expect(v.state).toBe("blocked");
    expect(v.tone).toBe("destructive");
    expect(v.blocked).toBe(true);
    // The latch's reset wins over the reading's window reset.
    expect(v.resetsAt).toBe(NOW + 2 * HOUR);
  });

  it("ignores an elapsed latch", () => {
    const v = deriveClaudeUsageView({ latchedUntil: NOW - 1, now: NOW });
    expect(v.state).toBe("unknown");
    expect(v.blocked).toBe(false);
  });

  it("degrades a reading whose window has already reset to unknown (not a stale 0%)", () => {
    const v = deriveClaudeUsageView({
      reading: { status: "warning", windowType: "five_hour", resetsAt: NOW - 1, capturedAt: NOW },
      now: NOW,
    });
    expect(v.state).toBe("unknown");
  });

  it("degrades a reading captured too long ago to unknown", () => {
    const v = deriveClaudeUsageView({
      reading: { status: "ok", windowType: "five_hour", resetsAt: null, capturedAt: NOW },
      now: NOW + 8 * 24 * HOUR,
    });
    expect(v.state).toBe("unknown");
  });
});

describe("formatResetCountdown", () => {
  it("returns null when there is nothing to count down to", () => {
    expect(formatResetCountdown(null, NOW)).toBeNull();
    expect(formatResetCountdown(NOW, NOW)).toBeNull();
    expect(formatResetCountdown(NOW - 5, NOW)).toBeNull();
  });

  it("formats sub-hour windows in minutes", () => {
    expect(formatResetCountdown(NOW + 45 * 60, NOW)).toBe("45m");
  });

  it("formats multi-hour windows with hours and minutes", () => {
    expect(formatResetCountdown(NOW + 2 * HOUR + 14 * 60, NOW)).toBe("2h 14m");
    expect(formatResetCountdown(NOW + 3 * HOUR, NOW)).toBe("3h");
  });

  it("formats multi-day windows with days and hours", () => {
    expect(formatResetCountdown(NOW + 2 * 24 * HOUR + 3 * HOUR, NOW)).toBe("2d 3h");
  });
});
