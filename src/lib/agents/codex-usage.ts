import { z } from "zod";

/**
 * Proactive Codex OAuth usage visibility (issue #189), the Codex counterpart to
 * the Claude indicator (#188, `claude-usage.ts`). Where the reactive latch
 * (issue #167, `provider-limit.ts`) only reacts *after* a job hits the wall,
 * Codex reports its ChatGPT-plan quota proactively in the `codex exec --json`
 * stream Drydock already parses — a `token_count` event with structured
 * `rate_limits` windows — so the dashboard can warn *before* work parks.
 *
 * Unlike Claude's qualitative status enum, Codex reports an exact
 * `used_percent` per window plus a reset offset, so the indicator renders a
 * real percentage and an escalating tier. This module is pure (no DB, no React)
 * so both the persistence layer and the dashboard components can import it.
 */

/** Subset of the UI status tones this feature maps onto (see `badge.tsx`). */
export type UsageTone = "neutral" | "success" | "warning" | "destructive";

/** Headline tier, escalating left-to-right; `blocked` is the parked latch. */
export type CodexUsageState = "unknown" | "ok" | "warn" | "critical" | "blocked";

/** Percent at which the indicator turns amber / red. */
export const USAGE_WARN_PERCENT = 75;
export const USAGE_CRITICAL_PERCENT = 90;

/** A reading older than this is treated as unknown even if a window is open. */
const FRESH_TTL_SEC = 7 * 24 * 3600;

const MIN = 60;
const HOUR = 3600;
const DAY = 86400;

// ---- Captured-from-stream reading (relative reset offsets) -----------------

/** One rate-limit window as read live from the Codex stream. */
export interface CodexUsageWindowReading {
  /** Percent of the window consumed, as reported by the CLI (0–100). */
  usedPercent: number;
  /** Length of the rolling window in minutes, when reported. */
  windowMinutes?: number;
  /** Seconds until the window resets, relative to capture, when reported. */
  resetsInSeconds?: number;
}

/** The Codex quota snapshot parsed from the stream (primary + weekly window). */
export interface CodexUsageReading {
  primary?: CodexUsageWindowReading;
  secondary?: CodexUsageWindowReading;
}

// ---- Persisted snapshot (absolute reset timestamps) ------------------------

/** A persisted usage window: percent consumed and the absolute reset time. */
export interface CodexUsageWindow {
  usedPercent: number;
  /** Epoch seconds when the window resets, when the CLI reported one. */
  resetsAt?: number;
  windowMinutes?: number;
}

/** The persisted Codex usage snapshot (the `provider_usage:codex` row). */
export interface CodexUsageSnapshot {
  /** Epoch seconds when this reading was captured (anchors the countdowns). */
  capturedAt: number;
  primary?: CodexUsageWindow;
  secondary?: CodexUsageWindow;
}

const windowSchema = z.object({
  usedPercent: z.number(),
  resetsAt: z.number().optional(),
  windowMinutes: z.number().optional(),
});

/** Zod schema for the persisted snapshot (validated on read, like the latch). */
export const codexSnapshotSchema = z.object({
  capturedAt: z.number(),
  primary: windowSchema.optional(),
  secondary: windowSchema.optional(),
});

/** Anchor a captured window's relative reset to an absolute timestamp. */
function windowFromReading(
  window: CodexUsageWindowReading | undefined,
  capturedAt: number,
): CodexUsageWindow | undefined {
  if (!window) return undefined;
  return {
    usedPercent: window.usedPercent,
    windowMinutes: window.windowMinutes,
    resetsAt:
      window.resetsInSeconds !== undefined ? capturedAt + window.resetsInSeconds : undefined,
  };
}

/**
 * Build the persistable snapshot from a freshly-captured reading, anchoring its
 * relative reset offsets to `now` so the countdowns stay correct across reloads.
 */
export function snapshotFromReading(reading: CodexUsageReading, now: number): CodexUsageSnapshot {
  return {
    capturedAt: now,
    primary: windowFromReading(reading.primary, now),
    secondary: windowFromReading(reading.secondary, now),
  };
}

// ---- View model ------------------------------------------------------------

/** Map a busiest-window percent to a non-blocked usage tier. */
export function usageStateFor(usedPercent: number): "ok" | "warn" | "critical" {
  if (usedPercent >= USAGE_CRITICAL_PERCENT) return "critical";
  if (usedPercent >= USAGE_WARN_PERCENT) return "warn";
  return "ok";
}

const TONE: Record<Exclude<CodexUsageState, "unknown">, UsageTone> = {
  ok: "success",
  warn: "warning",
  critical: "destructive",
  blocked: "destructive",
};
const LABEL: Record<CodexUsageState, string> = {
  unknown: "Usage unknown",
  ok: "OK",
  warn: "High usage",
  critical: "Critical",
  blocked: "Limit reached",
};

/** Status tone for a usage state, reusing the existing badge tokens. */
export function usageStateTone(state: CodexUsageState): UsageTone {
  return state === "unknown" ? "neutral" : TONE[state];
}

/** Render-ready Codex usage state for the navbar pill and dashboard card. */
export interface CodexUsageView {
  state: CodexUsageState;
  tone: UsageTone;
  label: string;
  /** Busiest window percent; drives the headline. Null when unknown. */
  usedPercent: number | null;
  primary: CodexUsageWindow | null;
  secondary: CodexUsageWindow | null;
  /** True when a provider-limit latch has parked Codex work (terminal state). */
  blocked: boolean;
  /** Epoch seconds the window/park resets, when known (drives the countdown). */
  resetsAt: number | null;
  /** Epoch seconds the underlying reading was captured, when one exists. */
  capturedAt: number | null;
}

const UNKNOWN_VIEW: CodexUsageView = {
  state: "unknown",
  tone: "neutral",
  label: "Usage unknown",
  usedPercent: null,
  primary: null,
  secondary: null,
  blocked: false,
  resetsAt: null,
  capturedAt: null,
};

/** The reported window's reset that anchors freshness/countdown (primary, else secondary). */
function resetAnchor(snapshot: CodexUsageSnapshot): number | undefined {
  return snapshot.primary?.resetsAt ?? snapshot.secondary?.resetsAt;
}

/** Whether a snapshot is too old to trust: its window elapsed, or it's ancient. */
function isStale(snapshot: CodexUsageSnapshot, now: number): boolean {
  const reset = resetAnchor(snapshot);
  if (reset !== undefined && reset <= now) return true;
  return now - snapshot.capturedAt > FRESH_TTL_SEC;
}

/** The highest percent across the reported windows, or null when none. */
function busiestPercent(snapshot: CodexUsageSnapshot): number | null {
  const percents = [snapshot.primary?.usedPercent, snapshot.secondary?.usedPercent].filter(
    (p): p is number => typeof p === "number",
  );
  return percents.length ? Math.max(...percents) : null;
}

/**
 * Merge the persisted snapshot with an active provider-limit latch into one
 * coherent view. The latch (a parked job, issue #167) is the terminal "limit
 * reached" case and wins over the percent; otherwise a fresh snapshot drives the
 * tier; a stale/missing snapshot degrades to "unknown" rather than a 0%.
 */
export function buildCodexUsageView(input: {
  snapshot?: CodexUsageSnapshot;
  /** Epoch seconds an active latch parks Codex until, when one is active. */
  latchedUntil?: number;
  now: number;
}): CodexUsageView {
  const { snapshot, latchedUntil, now } = input;
  const fresh = snapshot && !isStale(snapshot, now) ? snapshot : undefined;

  if (latchedUntil !== undefined && latchedUntil > now) {
    return {
      state: "blocked",
      tone: "destructive",
      label: LABEL.blocked,
      usedPercent: fresh ? busiestPercent(fresh) : null,
      primary: fresh?.primary ?? null,
      secondary: fresh?.secondary ?? null,
      blocked: true,
      resetsAt: latchedUntil,
      capturedAt: fresh?.capturedAt ?? null,
    };
  }

  if (fresh) {
    const usedPercent = busiestPercent(fresh);
    const state = usedPercent !== null ? usageStateFor(usedPercent) : "unknown";
    return {
      state,
      tone: usageStateTone(state),
      label: LABEL[state],
      usedPercent,
      primary: fresh.primary ?? null,
      secondary: fresh.secondary ?? null,
      blocked: false,
      resetsAt: resetAnchor(fresh) ?? null,
      capturedAt: fresh.capturedAt,
    };
  }

  return UNKNOWN_VIEW;
}

/** Human-readable countdown to a reset epoch, or null when none is pending. */
export function formatResetCountdown(resetsAt: number | null, now: number): string | null {
  if (resetsAt === null || resetsAt <= now) return null;
  const diff = resetsAt - now;
  if (diff < MIN) return `${diff}s`;
  if (diff < HOUR) return `${Math.floor(diff / MIN)}m`;
  if (diff < DAY) {
    const h = Math.floor(diff / HOUR);
    const m = Math.floor((diff % HOUR) / MIN);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(diff / DAY);
  const h = Math.floor((diff % DAY) / HOUR);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}
