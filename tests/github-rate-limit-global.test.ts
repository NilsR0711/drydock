import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Next.js compiles Server Actions, Route Handlers, and instrumentation into
 * separate bundle layers, each evaluating a module independently. The shared
 * rate-limit governor must therefore live on a process-global so a budget the
 * driver loop / gh client observe in one layer is visible to the `/api/health`
 * Route Handler and the dashboard queries in another — otherwise the surfaced
 * budget would always read null in production (issues #232, #408).
 *
 * `vi.resetModules()` between imports gives a fresh module evaluation, standing
 * in for those distinct bundle layers within a single test process.
 */
const GOVERNOR_KEY = Symbol.for("drydock.github.rate-limit.governor");

describe("sharedGovernor cross-bundle sharing (issue #408)", () => {
  afterEach(() => {
    vi.resetModules();
    // resetModules clears the module cache but leaves the process-global in
    // place; drop it so each test starts from a clean governor.
    delete (globalThis as Record<symbol, unknown>)[GOVERNOR_KEY];
  });

  it("returns the same governor instance across module layers", async () => {
    vi.resetModules();
    const layerA = await import("@/lib/github/rate-limit");
    layerA.sharedGovernor.observe("core", {
      remaining: 1000,
      limit: 5000,
      reset: 9_999_999_999,
    });

    // A second bundle layer loads its own copy of the module.
    vi.resetModules();
    const layerB = await import("@/lib/github/rate-limit");

    expect(layerB.sharedGovernor).toBe(layerA.sharedGovernor);
    expect(layerB.sharedGovernor.snapshot("core")).toEqual({
      remaining: 1000,
      limit: 5000,
      reset: 9_999_999_999,
    });
  });
});
