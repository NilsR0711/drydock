import type { RateBudget } from "./rate-limit";

/**
 * Render-ready GitHub API rate-limit budget for the navbar pill and dashboard
 * card (issue #408). The GitHub API budget is the third throttling resource
 * that shapes the dock — alongside the Claude and Codex subscription quotas —
 * and the only one without a proactive gauge. Where the governor (ADR 018)
 * silently defers background sweeps once the budget drops below the reserve
 * fraction, this surfaces that back-pressure so a stale backlog sync is
 * diagnosable from the UI rather than only from `console.debug`.
 */

/** Subset of the UI status tones this feature maps onto (see `badge.tsx`). */
export type UsageTone = "neutral" | "success" | "warning" | "destructive";

/** Re-exported here so the countdown formatter lives on the github surface. */
export { formatResetCountdown } from "@/lib/agents/claude-usage";

/**
 * Above the reserve fraction (where sweeps start deferring) but below this, the
 * budget is "getting low" — an amber heads-up before the gated band. Must stay
 * above the governor's reserve fraction (0.3) so the warning tier precedes the
 * destructive one.
 */
export const WARN_FRACTION = 0.5;

/** One resource's (REST/GraphQL) budget row for the dashboard card. */
export interface GithubBudgetResourceView {
  resource: "core" | "graphql";
  /** Short human label, e.g. "REST" / "GraphQL". */
  label: string;
  remaining: number;
  limit: number;
  /** Whole-number remaining percent, clamped 0–100. */
  remainingPercent: number;
  /** Epoch seconds when the window resets. */
  reset: number;
  /** True when background work against this resource is currently deferred. */
  gated: boolean;
  tone: UsageTone;
}

/** Render-ready aggregate budget state for the pill and the card headline. */
export interface GithubBudgetView {
  /** "unknown" until a resource is observed; else the worst observed tier. */
  state: "unknown" | "ok" | "warning" | "gated";
  tone: UsageTone;
  /** Short pill label, e.g. "GitHub 42%" / "Sweeps deferred". */
  label: string;
  /** Lowest remaining percent across observed resources; null when unknown. */
  remainingPercent: number | null;
  /** True when any observed resource is deferring background sweeps. */
  gated: boolean;
  /** Soonest relevant reset (epoch seconds); drives the countdown, null when unknown. */
  resetsAt: number | null;
  /** Per-resource detail rows in a stable order; only observed resources. */
  resources: GithubBudgetResourceView[];
}

const RESOURCE_LABEL: Record<"core" | "graphql", string> = {
  core: "REST",
  graphql: "GraphQL",
};

/** Remaining fraction, treating an absent/zero limit as full (never NaN). */
function fraction(b: RateBudget): number {
  return b.limit > 0 ? b.remaining / b.limit : 1;
}

/** Round a fraction to a whole percent, clamped to 0–100. */
function pct(value: number): number {
  return Math.round(Math.min(Math.max(value, 0), 100));
}

function resourceTone(b: RateBudget): UsageTone {
  if (b.gated) return "destructive";
  if (fraction(b) < WARN_FRACTION) return "warning";
  return "success";
}

const UNKNOWN_VIEW: GithubBudgetView = {
  state: "unknown",
  tone: "neutral",
  label: "Usage unknown",
  remainingPercent: null,
  gated: false,
  resetsAt: null,
  resources: [],
};

/**
 * Merge the observed `core`/`graphql` budgets into one coherent view. The
 * worst observed tier wins the headline: any gated resource → "Sweeps
 * deferred" (destructive); else a low-but-not-gated resource → warning; else
 * ok. A resource nothing has been observed for is omitted, and when neither is
 * observed the view degrades to "unknown" rather than a misleading 0%.
 */
export function deriveGithubBudgetView(input: {
  core: RateBudget | null;
  graphql: RateBudget | null;
}): GithubBudgetView {
  const observed: Array<["core" | "graphql", RateBudget]> = [];
  if (input.core) observed.push(["core", input.core]);
  if (input.graphql) observed.push(["graphql", input.graphql]);
  if (observed.length === 0) return UNKNOWN_VIEW;

  const resources: GithubBudgetResourceView[] = observed.map(([resource, b]) => ({
    resource,
    label: RESOURCE_LABEL[resource],
    remaining: b.remaining,
    limit: b.limit,
    remainingPercent: pct(fraction(b) * 100),
    reset: b.reset,
    gated: b.gated,
    tone: resourceTone(b),
  }));

  const anyGated = resources.some((r) => r.gated);
  const anyWarning = resources.some((r) => r.tone === "warning");
  const remainingPercent = Math.min(...resources.map((r) => r.remainingPercent));

  // Recovery countdown: when gated, the soonest reset among gated resources
  // (when the budget is expected to refill); otherwise the soonest overall.
  const relevant = anyGated ? resources.filter((r) => r.gated) : resources;
  const resetsAt = Math.min(...relevant.map((r) => r.reset));

  if (anyGated) {
    return {
      state: "gated",
      tone: "destructive",
      label: "Sweeps deferred",
      remainingPercent,
      gated: true,
      resetsAt,
      resources,
    };
  }
  return {
    state: anyWarning ? "warning" : "ok",
    tone: anyWarning ? "warning" : "success",
    label: `GitHub ${remainingPercent}%`,
    remainingPercent,
    gated: false,
    resetsAt,
    resources,
  };
}
