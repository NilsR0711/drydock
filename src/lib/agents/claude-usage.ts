import { z } from "zod";
import type { RawRateLimitInfo } from "@/lib/stream/parser";

/**
 * Proactive Claude OAuth usage visibility (issue #188). Where the reactive
 * latch (issue #166, `provider-limit.ts`) only reacts *after* a job hits the
 * wall, this reads the live subscription-window state the CLI streams on every
 * run (`rate_limit_event`) so the dashboard can warn *before* work parks.
 *
 * The installed CLI exposes a qualitative `status` enum
 * ("allowed" → "allowed_warning" → "rejected") and the window's `resetsAt`
 * epoch, not a raw percentage — so the indicator renders the escalating tier
 * plus a reset countdown rather than a misleading exact percent.
 */

/** Normalized subscription-window state, escalating left-to-right. */
export type ClaudeUsageStatus = "ok" | "warning" | "blocked";

/** Subset of the UI status tones this feature maps onto (see `badge.tsx`). */
export type UsageTone = "neutral" | "success" | "warning" | "destructive";

/** A captured, normalized reading of the Claude subscription window. */
export interface ClaudeUsageReading {
  /** Normalized window state from the CLI's `rate_limit_info.status`. */
  status: ClaudeUsageStatus;
  /** Which window this describes, e.g. "five_hour" / "weekly" / "unknown". */
  windowType: string;
  /** Epoch seconds when the window resets, or null when the CLI omitted it. */
  resetsAt: number | null;
  /** Epoch seconds when Drydock captured this reading. */
  capturedAt: number;
}

/** Zod schema for the persisted reading (validated on read, like the latch). */
export const usageReadingSchema = z.object({
  status: z.enum(["ok", "warning", "blocked"]),
  windowType: z.string(),
  resetsAt: z.number().nullable(),
  capturedAt: z.number(),
});

/** Render-ready usage state for the navbar pill and the dashboard card. */
export interface ClaudeUsageView {
  /** Display state; "unknown" when no fresh reading and no active latch exist. */
  state: ClaudeUsageStatus | "unknown";
  /** Status tone to colour the indicator. */
  tone: UsageTone;
  /** Short human label, e.g. "OK" / "Limit near" / "Limit reached". */
  label: string;
  /** Window this view describes, when known. */
  windowType: string | null;
  /** Epoch seconds the window/park resets, when known (drives the countdown). */
  resetsAt: number | null;
  /** True when a provider-limit latch has parked Claude work (terminal state). */
  blocked: boolean;
  /** Epoch seconds the underlying reading was captured, when one exists. */
  capturedAt: number | null;
}

/** A reading older than this is treated as unknown even if its window is open. */
const FRESH_TTL_SEC = 7 * 24 * 3600;

/** Map the CLI's raw status string to a normalized state, or undefined. */
export function normalizeUsageStatus(raw: string | undefined): ClaudeUsageStatus | undefined {
  switch (raw?.toLowerCase()) {
    case "allowed":
      return "ok";
    case "allowed_warning":
    case "warning":
      return "warning";
    case "rejected":
    case "blocked":
      return "blocked";
    default:
      return undefined;
  }
}

/**
 * Build a normalized reading from a streamed `rate_limit_info`, or undefined
 * when it carries no usable signal. A recognized status wins; a bare reset
 * epoch (no status) is treated as "ok" so the countdown is still surfaced.
 */
export function readingFromRateLimit(
  info: RawRateLimitInfo | undefined,
  capturedAt: number,
): ClaudeUsageReading | undefined {
  if (!info) return undefined;
  const status = normalizeUsageStatus(info.status);
  const hasReset = typeof info.resetsAt === "number";
  if (info.status !== undefined && status === undefined) return undefined;
  if (status === undefined && !hasReset) return undefined;
  return {
    status: status ?? "ok",
    windowType: info.rateLimitType ?? "unknown",
    resetsAt: hasReset ? (info.resetsAt as number) : null,
    capturedAt,
  };
}

const TONE: Record<ClaudeUsageStatus, UsageTone> = {
  ok: "success",
  warning: "warning",
  blocked: "destructive",
};
const LABEL: Record<ClaudeUsageStatus, string> = {
  ok: "OK",
  warning: "Limit near",
  blocked: "Limit reached",
};

const UNKNOWN_VIEW: ClaudeUsageView = {
  state: "unknown",
  tone: "neutral",
  label: "Usage unknown",
  windowType: null,
  resetsAt: null,
  blocked: false,
  capturedAt: null,
};

/** Whether a reading is too old to trust: its window elapsed, or it's ancient. */
function isStale(reading: ClaudeUsageReading, now: number): boolean {
  if (reading.resetsAt !== null && reading.resetsAt <= now) return true;
  return now - reading.capturedAt > FRESH_TTL_SEC;
}

/**
 * Merge the live reading with an active provider-limit latch into one coherent
 * view. The latch (a parked job, issue #166) is the terminal "limit reached"
 * case and wins over the reading; otherwise a fresh reading drives the tier; a
 * stale/missing reading degrades to "unknown" rather than a misleading 0%.
 */
export function deriveClaudeUsageView(input: {
  reading?: ClaudeUsageReading;
  /** Epoch seconds an active latch parks Claude until, when one is active. */
  latchedUntil?: number;
  now: number;
}): ClaudeUsageView {
  const { reading, latchedUntil, now } = input;

  if (latchedUntil !== undefined && latchedUntil > now) {
    return {
      state: "blocked",
      tone: "destructive",
      label: "Limit reached",
      windowType: reading?.windowType ?? null,
      resetsAt: latchedUntil,
      blocked: true,
      capturedAt: reading?.capturedAt ?? null,
    };
  }

  if (reading && !isStale(reading, now)) {
    return {
      state: reading.status,
      tone: TONE[reading.status],
      label: LABEL[reading.status],
      windowType: reading.windowType,
      resetsAt: reading.resetsAt,
      blocked: false,
      capturedAt: reading.capturedAt,
    };
  }

  return UNKNOWN_VIEW;
}

/** Human-readable countdown to a reset epoch, or null when none is pending. */
export function formatResetCountdown(resetsAt: number | null, now: number): string | null {
  if (resetsAt === null || resetsAt <= now) return null;
  const diff = resetsAt - now;
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) {
    const h = Math.floor(diff / 3600);
    const m = Math.floor((diff % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(diff / 86400);
  const h = Math.floor((diff % 86400) / 3600);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}
