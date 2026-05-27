import { describe, expect, it } from "vitest";
import {
  HARD_FLOOR,
  parseRateLimitHeaders,
  RateLimitGovernor,
  RESERVE_FRACTION,
} from "@/lib/github/rate-limit";

/** A governor with a controllable clock (ms). */
function makeGovernor(startMs = 1_000_000) {
  let now = startMs;
  const gov = new RateLimitGovernor({ now: () => now });
  return { gov, setNow: (ms: number) => (now = ms), advance: (ms: number) => (now += ms) };
}

describe("RateLimitGovernor.decide", () => {
  it("allows any priority when no state has been observed", () => {
    const { gov } = makeGovernor();
    expect(gov.decide("core", "low").allowed).toBe(true);
    expect(gov.decide("core", "high").allowed).toBe(true);
  });

  it("allows both priorities above the reserve fraction", () => {
    const { gov } = makeGovernor();
    gov.observe("core", { remaining: 4000, limit: 5000, reset: 2000 }); // 80%
    expect(gov.decide("core", "low").allowed).toBe(true);
    expect(gov.decide("core", "high").allowed).toBe(true);
  });

  it("gates low priority once below the reserve fraction but lets high flow", () => {
    const { gov } = makeGovernor();
    // 20% remaining: below 30% reserve, above 5% floor.
    gov.observe("core", { remaining: 1000, limit: 5000, reset: 2000 });
    const low = gov.decide("core", "low");
    expect(low.allowed).toBe(false);
    expect(low.allowed === false && low.reason).toBe("reserve");
    expect(gov.decide("core", "high").allowed).toBe(true);
  });

  it("gates every priority below the hard floor", () => {
    const { gov } = makeGovernor();
    // 4% remaining: below the 5% floor.
    gov.observe("core", { remaining: 200, limit: 5000, reset: 2000 });
    const high = gov.decide("core", "high");
    expect(high.allowed).toBe(false);
    expect(high.allowed === false && high.reason).toBe("floor");
    expect(gov.decide("core", "low").allowed).toBe(false);
  });

  it("scopes state per resource", () => {
    const { gov } = makeGovernor();
    gov.observe("search", { remaining: 1, limit: 30, reset: 2000 }); // search starved
    expect(gov.decide("search", "high").allowed).toBe(false);
    expect(gov.decide("core", "high").allowed).toBe(true); // core untouched
  });

  it("reports retryAfterMs until the reset for a gated low request", () => {
    const { gov } = makeGovernor(1_000_000);
    gov.observe("core", { remaining: 1000, limit: 5000, reset: 1001 }); // reset at 1001s
    const low = gov.decide("core", "low");
    expect(low.allowed).toBe(false);
    expect(low.allowed === false && low.retryAfterMs).toBe(1_001_000 - 1_000_000);
  });

  it("ignores stale state once the reset window has elapsed", () => {
    const { gov, setNow } = makeGovernor(1_000_000);
    gov.observe("core", { remaining: 10, limit: 5000, reset: 1001 }); // starved, resets at 1001s
    expect(gov.decide("core", "low").allowed).toBe(false);
    setNow(1_002_000); // past the reset: budget has refilled, state is stale
    expect(gov.decide("core", "low").allowed).toBe(true);
  });
});

describe("RateLimitGovernor.note429", () => {
  it("blocks every request until the provided reset, regardless of priority", () => {
    const { gov, advance } = makeGovernor(1_000_000);
    gov.note429("core", 1_030); // reset 30s out (epoch seconds)
    const high = gov.decide("core", "high");
    expect(high.allowed).toBe(false);
    expect(high.allowed === false && high.reason).toBe("limited");
    expect(high.allowed === false && high.retryAfterMs).toBe(30_000);
    advance(30_001);
    expect(gov.decide("core", "high").allowed).toBe(true);
  });

  it("falls back to a ~60s window when no reset is given", () => {
    const { gov } = makeGovernor(1_000_000);
    gov.note429("core");
    const d = gov.decide("core", "high");
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.retryAfterMs).toBe(60_000);
  });
});

describe("parseRateLimitHeaders", () => {
  it("derives a per-resource snapshot from response headers", () => {
    const parsed = parseRateLimitHeaders({
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "4998",
      "x-ratelimit-reset": "1700000000",
      "x-ratelimit-resource": "core",
    });
    expect(parsed).toEqual({
      resource: "core",
      snapshot: { remaining: 4998, limit: 5000, reset: 1700000000 },
    });
  });

  it("defaults to the core resource when the header is absent", () => {
    const parsed = parseRateLimitHeaders({
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "4998",
      "x-ratelimit-reset": "1700000000",
    });
    expect(parsed?.resource).toBe("core");
  });

  it("returns null when the rate-limit headers are missing", () => {
    expect(parseRateLimitHeaders({ "content-type": "application/json" })).toBeNull();
  });

  it("ignores an unknown resource value", () => {
    const parsed = parseRateLimitHeaders({
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "10",
      "x-ratelimit-reset": "1700000000",
      "x-ratelimit-resource": "weird",
    });
    expect(parsed).toBeNull();
  });
});

describe("exported thresholds", () => {
  it("uses a 0.3 reserve fraction and a 0.05 hard floor", () => {
    expect(RESERVE_FRACTION).toBe(0.3);
    expect(HARD_FLOOR).toBe(0.05);
  });
});
