import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Next.js compiles Server Actions, Route Handlers, and instrumentation into
 * separate bundle layers that each get their own instance of a module-level
 * singleton. The dashboard bus must therefore keep its listener registry on a
 * process-global so an emit from one layer (the add-repo Server Action) reaches
 * a listener registered in another (the dashboard SSE Route Handler). Without
 * that, the repo list/count never updates live after adding a repo (issue #232).
 *
 * `vi.resetModules()` between imports gives a fresh module evaluation, standing
 * in for those distinct bundle layers within a single test process.
 */
describe("dashboard-bus cross-bundle sharing (issue #232)", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("delivers an emit from one module instance to a listener on another", async () => {
    vi.resetModules();
    const routeLayer = await import("@/lib/stream/dashboard-bus");
    const fired = vi.fn();
    const off = routeLayer.onDashboardChange(fired);

    // A second bundle layer loads its own copy of the module.
    vi.resetModules();
    const actionLayer = await import("@/lib/stream/dashboard-bus");

    actionLayer.emitDashboardChange();
    expect(fired).toHaveBeenCalledTimes(1);

    off();
  });

  it("shares the live listener count across module instances", async () => {
    vi.resetModules();
    const routeLayer = await import("@/lib/stream/dashboard-bus");
    const off = routeLayer.onDashboardChange(() => {});

    vi.resetModules();
    const actionLayer = await import("@/lib/stream/dashboard-bus");
    expect(actionLayer.dashboardListenerCount()).toBe(1);

    off();
    expect(actionLayer.dashboardListenerCount()).toBe(0);
  });
});
