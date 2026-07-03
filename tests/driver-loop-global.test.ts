import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The driver-loop's `running`/`timer`/`ticking` state must be shared across
 * bundle layers (issue #379). The real loop runs in the orchestrator layer, but
 * `drydock stop` calls gracefulShutdown → stopDriverLoop from the Route Handler
 * layer. With module-local loop state, the route layer flips its own idle
 * `running` flag and clears an undefined timer while the real loop keeps its
 * timer and goes on claiming queued jobs during the shutdown window. A
 * process-global container lets the shutdown path stop the real loop.
 *
 * `vi.resetModules()` between imports gives a fresh module evaluation, standing
 * in for those distinct bundle layers within a single test process.
 */
const DRIVER_LOOP_STATE_KEY = Symbol.for("drydock.orchestrator.driver-loop-state");

describe("driver-loop cross-bundle sharing (issue #379)", () => {
  afterEach(() => {
    vi.resetModules();
    delete (globalThis as Record<symbol, unknown>)[DRIVER_LOOP_STATE_KEY];
  });

  it("reflects a loop started in another module instance and stops it", async () => {
    vi.useFakeTimers();

    vi.resetModules();
    const orchestratorLayer = await import("@/lib/orchestrator/driver-loop");
    let ticks = 0;
    orchestratorLayer.startDriverLoop({
      intervalMs: 1000,
      maxTickMs: 0,
      tick: async () => void ticks++,
    });
    await vi.advanceTimersByTimeAsync(0); // immediate first tick
    await vi.advanceTimersByTimeAsync(1000); // one interval tick
    expect(ticks).toBeGreaterThanOrEqual(2);

    // A second bundle layer (the shutdown route) loads its own copy of the module.
    vi.resetModules();
    const routeLayer = await import("@/lib/orchestrator/driver-loop");
    // It observes the real loop as running...
    expect(routeLayer.driverLoopStatus().running).toBe(true);

    // ...and stopDriverLoop from that layer actually stops the real loop's timer.
    routeLayer.stopDriverLoop();
    expect(orchestratorLayer.driverLoopStatus().running).toBe(false);
    const after = ticks;
    await vi.advanceTimersByTimeAsync(5000);
    expect(ticks).toBe(after); // no ticks after the cross-layer stop

    vi.useRealTimers();
  });
});
