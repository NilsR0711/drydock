import { afterEach, describe, expect, it, vi } from "vitest";
import { driverLoopStatus, startDriverLoop, stopDriverLoop } from "@/lib/orchestrator/driver-loop";

afterEach(() => stopDriverLoop());

describe("startDriverLoop", () => {
  it("ticks repeatedly on the interval and stops cleanly", async () => {
    vi.useFakeTimers();
    let ticks = 0;
    startDriverLoop({ intervalMs: 1000, tick: async () => void ticks++ });
    await vi.advanceTimersByTimeAsync(0); // initial immediate tick
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    stopDriverLoop();
    const after = ticks;
    await vi.advanceTimersByTimeAsync(5000);
    expect(ticks).toBe(after); // no ticks after stop
    expect(after).toBeGreaterThanOrEqual(3);
    vi.useRealTimers();
  });

  it("is idempotent — a second start does not double-schedule", async () => {
    vi.useFakeTimers();
    let ticks = 0;
    startDriverLoop({ intervalMs: 1000, tick: async () => void ticks++ });
    startDriverLoop({ intervalMs: 1000, tick: async () => void ticks++ });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    stopDriverLoop();
    expect(ticks).toBeLessThanOrEqual(2); // one immediate + one interval, not doubled
    vi.useRealTimers();
  });
});

describe("driverLoopStatus", () => {
  it("tracks running state, interval, and the last tick start time", async () => {
    vi.useFakeTimers();
    startDriverLoop({ intervalMs: 1000, tick: async () => {} });
    await vi.advanceTimersByTimeAsync(0); // immediate first tick
    const first = driverLoopStatus();
    expect(first.running).toBe(true);
    expect(first.intervalMs).toBe(1000);
    expect(first.lastTickAt).toBe(Date.now());

    await vi.advanceTimersByTimeAsync(1000); // second tick fires on the interval
    const second = driverLoopStatus();
    expect(second.lastTickAt).toBe(Date.now());
    expect(second.lastTickAt).toBeGreaterThan(first.lastTickAt as number);

    stopDriverLoop();
    expect(driverLoopStatus().running).toBe(false);
    vi.useRealTimers();
  });

  it("freezes lastTickAt while a tick hangs, so staleness is observable", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const tick = (): Promise<void> => {
      calls++;
      return calls === 1 ? Promise.resolve() : new Promise<void>(() => {}); // 2nd tick hangs
    };
    startDriverLoop({ intervalMs: 1000, tick });
    await vi.advanceTimersByTimeAsync(0); // tick 1 completes
    await vi.advanceTimersByTimeAsync(1000); // tick 2 starts and never resolves
    const hungAt = driverLoopStatus().lastTickAt;
    expect(hungAt).toBe(Date.now());

    await vi.advanceTimersByTimeAsync(10_000); // loop is wedged — no new tick starts
    expect(driverLoopStatus().lastTickAt).toBe(hungAt);
    vi.useRealTimers();
  });
});
