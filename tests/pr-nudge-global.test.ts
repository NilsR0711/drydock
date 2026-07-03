import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The PR-nudge waiter registry connects the CI babysitter (which sleeps between
 * polls in the driver-loop layer) to the webhook receiver (which nudges from a
 * Route Handler layer). With a module-local `waiters` Set, the webhook layer
 * nudges an empty set while the babysitter waits in its own — so a verified
 * check/review webhook never cuts the poll short and the issue #180 latency
 * feature is silently inert in the standard single-process deployment (#379).
 * The registry must live on a process-global.
 *
 * `vi.resetModules()` between imports gives a fresh module evaluation, standing
 * in for those distinct bundle layers within a single test process.
 */
const WAITERS_KEY = Symbol.for("drydock.orchestrator.pr-nudge-waiters");

describe("pr-nudge cross-bundle sharing (issue #379)", () => {
  afterEach(() => {
    vi.resetModules();
    delete (globalThis as Record<symbol, unknown>)[WAITERS_KEY];
  });

  it("wakes a waiter registered on another module instance", async () => {
    // The babysitter's nudge-aware sleep registers in the driver-loop layer.
    vi.resetModules();
    const babysitterLayer = await import("@/lib/orchestrator/pr-nudge");
    let wokenReason: string | undefined;
    const sleeping = babysitterLayer.nudgeAwareSleep({
      repoId: 1,
      prNumber: 5,
      onNudge: (reason) => {
        wokenReason = reason;
      },
    })(30_000);

    // A verified webhook nudges from the Route Handler layer.
    vi.resetModules();
    const webhookLayer = await import("@/lib/orchestrator/pr-nudge");
    expect(webhookLayer.nudgePrWaiters(1, [5], "check_suite completed")).toBe(1);

    await sleeping;
    expect(wokenReason).toBe("check_suite completed");
    expect(webhookLayer.__prNudgeWaiterCount()).toBe(0);
  });
});
