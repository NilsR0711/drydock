import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `startOrchestrator()` is bootstrapped lazily from getDb(), which every bundle
 * layer evaluates independently (RSC render, any Server Action, any Route
 * Handler). With a module-local `started` guard, the first getDb() in each layer
 * re-runs the whole bootstrap: crash recovery (requeueExpiredLeases against live
 * jobs), a stolen instance lock, a second driver loop, and duplicate signal
 * handlers (issue #379). The guard must live on a process-global so the bootstrap
 * runs at most once per process, regardless of how many layers call getDb().
 *
 * The bootstrap's heavy work is skipped under Vitest, but installing the
 * graceful-shutdown signal handler is not — so a duplicate handler is the
 * observable proof that a second layer re-ran the bootstrap. getSettings is
 * stubbed so the guard, not a real DB open, is what this asserts.
 *
 * `vi.resetModules()` between imports gives a fresh module evaluation, standing
 * in for those distinct bundle layers within a single test process.
 */
vi.mock("@/lib/settings/service", () => ({
  getSettings: () => ({ logLevel: "info" }),
}));

const STARTED_KEY = Symbol.for("drydock.orchestrator.started");

describe("startOrchestrator started-guard cross-bundle sharing (issue #379)", () => {
  let sigtermBefore: ((...args: unknown[]) => void)[];
  let sigintBefore: ((...args: unknown[]) => void)[];

  beforeEach(() => {
    sigtermBefore = process.listeners("SIGTERM") as ((...args: unknown[]) => void)[];
    sigintBefore = process.listeners("SIGINT") as ((...args: unknown[]) => void)[];
  });

  afterEach(() => {
    // Remove only the graceful-shutdown handlers this test installed, never
    // Vitest's own, so the process is left exactly as we found it.
    for (const l of process.listeners("SIGTERM") as ((...args: unknown[]) => void)[]) {
      if (!sigtermBefore.includes(l)) process.removeListener("SIGTERM", l);
    }
    for (const l of process.listeners("SIGINT") as ((...args: unknown[]) => void)[]) {
      if (!sigintBefore.includes(l)) process.removeListener("SIGINT", l);
    }
    vi.resetModules();
    delete (globalThis as Record<symbol, unknown>)[STARTED_KEY];
  });

  it("runs the bootstrap at most once across two module instances", async () => {
    const baseline = process.listeners("SIGTERM").length;

    vi.resetModules();
    const orchestratorLayer = await import("@/lib/orchestrator/singleton");
    orchestratorLayer.startOrchestrator();
    const afterFirst = process.listeners("SIGTERM").length;
    // The first bootstrap installs exactly one graceful-shutdown handler.
    expect(afterFirst).toBe(baseline + 1);

    // A second bundle layer's getDb() re-invokes startOrchestrator; the shared
    // guard makes it a no-op — no second bootstrap, no duplicate handler.
    vi.resetModules();
    const routeLayer = await import("@/lib/orchestrator/singleton");
    routeLayer.startOrchestrator();
    expect(process.listeners("SIGTERM").length).toBe(afterFirst);
  });
});
