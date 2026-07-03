import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The webhook-triggered review-feedback sweep is debounced through a
 * `pendingSweeps` registry so a bot review burst coalesces into one sweep
 * (issue #180). The cadence sweep runs in the driver-loop layer and
 * webhook-triggered sweeps run in a Route Handler layer; with a module-local
 * `pendingSweeps` each layer debounces independently, so a driver-tick sweep and
 * a webhook sweep for the same repo no longer collapse into one (issue #379).
 * The debounce registry must live on a process-global, matching the sweep chain
 * that already does.
 *
 * `vi.resetModules()` between imports gives a fresh module evaluation, standing
 * in for those distinct bundle layers within a single test process.
 */
const PENDING_SWEEPS_KEY = Symbol.for("drydock.review-feedback.pending-sweeps");

describe("triggerReviewFeedbackSweep cross-bundle debounce (issue #379)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    delete (globalThis as Record<symbol, unknown>)[PENDING_SWEEPS_KEY];
  });

  it("coalesces triggers for one repo across two module instances into one sweep", async () => {
    vi.useFakeTimers();

    vi.resetModules();
    const driverLayer = await import("@/lib/orchestrator/review-feedback-driver");
    const runsA: number[] = [];
    driverLayer.__setReviewSweepRunner(async (id) => void runsA.push(id));

    vi.resetModules();
    const webhookLayer = await import("@/lib/orchestrator/review-feedback-driver");
    const runsB: number[] = [];
    webhookLayer.__setReviewSweepRunner(async (id) => void runsB.push(id));

    // The driver-loop layer schedules a debounced sweep for repo 1.
    driverLayer.triggerReviewFeedbackSweep(1);
    // The webhook layer observes the same pending entry (shared registry).
    expect(webhookLayer.__pendingReviewSweepCount()).toBe(1);

    // A webhook trigger for the same repo coalesces onto that slot, not a second.
    webhookLayer.triggerReviewFeedbackSweep(1);
    expect(driverLayer.__pendingReviewSweepCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(webhookLayer.REVIEW_SWEEP_DEBOUNCE_MS);

    // Exactly one sweep fired across both layers, and the registry drained.
    expect(runsA.length + runsB.length).toBe(1);
    expect(driverLayer.__pendingReviewSweepCount()).toBe(0);

    driverLayer.__setReviewSweepRunner(null);
    webhookLayer.__setReviewSweepRunner(null);
  });
});
