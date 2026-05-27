import type { RequestPriority } from "./priority";

/**
 * GitHub rate-limit resources Drydock distinguishes. The REST endpoints used by
 * the `gh` CLI count against `core`; `gh search` against `search`; GraphQL
 * against `graphql`. Each has its own remaining/limit/reset window.
 */
export type RateResource = "core" | "graphql" | "search";

const RATE_RESOURCES: readonly RateResource[] = ["core", "graphql", "search"];

function isRateResource(value: string): value is RateResource {
  return (RATE_RESOURCES as readonly string[]).includes(value);
}

/**
 * Below this fraction of the limit, background (`low`) requests are gated so the
 * remaining budget is reserved for interactive routes and active jobs.
 */
export const RESERVE_FRACTION = 0.3;

/**
 * Below this fraction, *every* request is gated regardless of priority — even
 * high-priority automation must not drain the budget to zero.
 */
export const HARD_FLOOR = 0.05;

/** Fallback backoff window for a 429 with no usable reset header (ms). */
const DEFAULT_429_BACKOFF_MS = 60_000;

/** A point-in-time view of one resource's budget. `reset` is epoch seconds. */
export interface RateSnapshot {
  remaining: number;
  limit: number;
  reset: number;
}

/** Why a request was gated, and how long until it could succeed. */
export type RateDecision =
  | { allowed: true }
  | { allowed: false; reason: "reserve" | "floor" | "limited"; retryAfterMs: number };

interface ResourceState {
  snapshot?: RateSnapshot;
  /** Epoch ms until which the resource is hard-blocked after a 429. */
  limitedUntilMs?: number;
}

export interface RateLimitGovernorOptions {
  /** Injectable clock (epoch ms); defaults to Date.now. */
  now?: () => number;
}

/**
 * Priority-aware rate-limit accounting. Tracks each resource's remaining budget
 * (from observed response headers) and gates requests so background work yields
 * to interactive work and no burst can zero out the budget:
 *
 * - below {@link RESERVE_FRACTION}: `low` requests are gated, `high` still flow;
 * - below {@link HARD_FLOOR}: all requests are gated;
 * - after a 429: all requests are gated until the reset window elapses.
 */
export class RateLimitGovernor {
  private readonly now: () => number;
  private readonly resources = new Map<RateResource, ResourceState>();

  constructor(opts: RateLimitGovernorOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** Record the latest budget for a resource, derived from response headers. */
  observe(resource: RateResource, snapshot: RateSnapshot): void {
    this.state(resource).snapshot = snapshot;
  }

  /**
   * Mark a resource rate-limited after an actual 429. Honors the reset header
   * (epoch seconds) when given, falling back to a ~60s window otherwise.
   */
  note429(resource: RateResource, resetEpochSec?: number): void {
    const until =
      resetEpochSec !== undefined ? resetEpochSec * 1000 : this.now() + DEFAULT_429_BACKOFF_MS;
    this.state(resource).limitedUntilMs = until;
  }

  /** Decide whether a request of the given priority may proceed now. */
  decide(resource: RateResource, priority: RequestPriority): RateDecision {
    const state = this.resources.get(resource);
    if (!state) return { allowed: true };

    const now = this.now();

    // 1. Active 429 backoff blocks everything until the reset window elapses.
    if (state.limitedUntilMs !== undefined && now < state.limitedUntilMs) {
      return { allowed: false, reason: "limited", retryAfterMs: state.limitedUntilMs - now };
    }

    const snap = state.snapshot;
    if (!snap || snap.limit <= 0) return { allowed: true };

    // A reset that has already passed means the window refilled; the cached
    // remaining is stale, so don't gate on it — let a fresh probe update us.
    const resetMs = snap.reset * 1000;
    if (now >= resetMs) return { allowed: true };

    const fraction = snap.remaining / snap.limit;
    const retryAfterMs = resetMs - now;

    if (fraction < HARD_FLOOR) return { allowed: false, reason: "floor", retryAfterMs };
    if (priority === "low" && fraction < RESERVE_FRACTION) {
      return { allowed: false, reason: "reserve", retryAfterMs };
    }
    return { allowed: true };
  }

  /** Current known budget for a resource, if any has been observed. */
  snapshot(resource: RateResource): Readonly<RateSnapshot> | undefined {
    return this.resources.get(resource)?.snapshot;
  }

  private state(resource: RateResource): ResourceState {
    let s = this.resources.get(resource);
    if (!s) {
      s = {};
      this.resources.set(resource, s);
    }
    return s;
  }
}

/** Process-wide governor shared by every GitHub client (see GhClient). */
export const sharedGovernor = new RateLimitGovernor();

/**
 * Thrown when the governor gates a request before it is sent: a `low`-priority
 * request below the reserve fraction, any request below the hard floor, or any
 * request during a 429 backoff window. `retryAfterMs` is how long until the
 * budget is expected to recover.
 */
export class RateLimitError extends Error {
  constructor(
    readonly reason: "reserve" | "floor" | "limited",
    readonly resource: RateResource,
    readonly retryAfterMs: number,
  ) {
    super(
      `github ${resource} rate limit gated (${reason}); retry in ~${Math.ceil(retryAfterMs / 1000)}s`,
    );
    this.name = "RateLimitError";
  }
}

/**
 * Derive a per-resource snapshot from response headers (case-insensitive keys
 * are expected to be lower-cased by the caller). Returns null when the
 * rate-limit headers are absent or name an unknown resource.
 */
export function parseRateLimitHeaders(
  headers: Record<string, string>,
): { resource: RateResource; snapshot: RateSnapshot } | null {
  const limit = Number(headers["x-ratelimit-limit"]);
  const remaining = Number(headers["x-ratelimit-remaining"]);
  const reset = Number(headers["x-ratelimit-reset"]);
  if (!Number.isFinite(limit) || !Number.isFinite(remaining) || !Number.isFinite(reset)) {
    return null;
  }
  const resourceHeader = headers["x-ratelimit-resource"];
  if (resourceHeader === undefined) {
    return { resource: "core", snapshot: { remaining, limit, reset } };
  }
  if (!isRateResource(resourceHeader)) return null;
  return { resource: resourceHeader, snapshot: { remaining, limit, reset } };
}
