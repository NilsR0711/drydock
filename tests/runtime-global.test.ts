import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The orchestrator's drain flag and active-job set must be shared across bundle
 * layers (issue #379). `drydock stop` calls gracefulShutdown from the Route
 * Handler layer, but the real driver loop and its in-flight jobs live in the
 * orchestrator layer. With a module-local `draining`/`activeJobs`, the route
 * layer flips its own copy: the real loop keeps claiming work and waitForIdle
 * polls an always-empty set, so process.exit fires mid-cleanup. A process-global
 * registry makes the shutdown path observe the loop's real state.
 *
 * `vi.resetModules()` between imports gives a fresh module evaluation, standing
 * in for those distinct bundle layers within a single test process.
 */
const RUNTIME_STATE_KEY = Symbol.for("drydock.orchestrator.runtime-state");

describe("runtime cross-bundle sharing (issue #379)", () => {
  afterEach(() => {
    vi.resetModules();
    delete (globalThis as Record<symbol, unknown>)[RUNTIME_STATE_KEY];
  });

  it("shares the drain flag across two module instances", async () => {
    vi.resetModules();
    const orchestratorLayer = await import("@/lib/orchestrator/runtime");

    vi.resetModules();
    const routeLayer = await import("@/lib/orchestrator/runtime");

    expect(orchestratorLayer.isDraining()).toBe(false);
    // The shutdown route (a second layer) flips drain mode.
    routeLayer.setDrainMode(true);
    // The orchestrator layer's driveTick must observe it.
    expect(orchestratorLayer.isDraining()).toBe(true);
  });

  it("shares the active-job set so waitForIdle observes the real loop's jobs", async () => {
    vi.resetModules();
    const orchestratorLayer = await import("@/lib/orchestrator/runtime");

    vi.resetModules();
    const routeLayer = await import("@/lib/orchestrator/runtime");

    // A job runs under the orchestrator layer's driver loop.
    orchestratorLayer.registerActiveJob(42);
    expect(routeLayer.activeJobCount()).toBe(1);

    // waitForIdle called from the route layer (gracefulShutdown) must wait for
    // that job, not resolve instantly against an empty per-layer set.
    let resolved = false;
    const idle = routeLayer.waitForIdle(1000, 5).then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);

    orchestratorLayer.unregisterActiveJob(42);
    await idle;
    expect(resolved).toBe(true);
  });
});
