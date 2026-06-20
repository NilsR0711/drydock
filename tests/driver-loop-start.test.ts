import { afterEach, describe, expect, it, vi } from "vitest";
import { driverLoopStatus, startDriverLoop, stopDriverLoop } from "@/lib/orchestrator/driver-loop";

afterEach(() => stopDriverLoop());

describe("startDriverLoop", () => {
  it("ticks repeatedly on the interval and stops cleanly", async () => {
    vi.useFakeTimers();
    let ticks = 0;
    startDriverLoop({ intervalMs: 1000, maxTickMs: 0, tick: async () => void ticks++ });
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
    startDriverLoop({ intervalMs: 1000, maxTickMs: 0, tick: async () => void ticks++ });
    startDriverLoop({ intervalMs: 1000, maxTickMs: 0, tick: async () => void ticks++ });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    stopDriverLoop();
    expect(ticks).toBeLessThanOrEqual(2); // one immediate + one interval, not doubled
    vi.useRealTimers();
  });

  it("abandons a hung tick at the watchdog deadline and keeps ticking (issue #359)", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const tick = (): Promise<void> => {
      calls++;
      // The first tick hangs forever (e.g. a stalled `gh` call); later ticks
      // resolve immediately, as they would once GitHub is reachable again.
      return calls === 1 ? new Promise<void>(() => {}) : Promise.resolve();
    };
    startDriverLoop({ intervalMs: 1000, maxTickMs: 2000, tick });
    await vi.advanceTimersByTimeAsync(0); // t=0: tick 1 starts and hangs
    const hungAt = driverLoopStatus().lastTickAt;
    expect(calls).toBe(1);

    // Before the deadline the re-entrancy guard still blocks overlap — no new
    // tick starts and the stall stays observable via a frozen lastTickAt.
    await vi.advanceTimersByTimeAsync(1500); // t=1500, < 2000 deadline
    expect(calls).toBe(1);
    expect(driverLoopStatus().lastTickAt).toBe(hungAt);

    // After the 2s watchdog deadline the hung tick is abandoned, the guard is
    // cleared, and the loop reschedules — so the next tick runs and lastTickAt
    // advances. The loop self-heals without a process restart.
    await vi.advanceTimersByTimeAsync(2500); // t=4000: deadline + next interval
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(driverLoopStatus().lastTickAt).toBeGreaterThan(hungAt as number);
    stopDriverLoop();
    vi.useRealTimers();
  });

  it("wedges on a hung tick when the watchdog is disabled (maxTickMs = 0)", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const tick = (): Promise<void> => {
      calls++;
      return calls === 1 ? Promise.resolve() : new Promise<void>(() => {}); // 2nd tick hangs
    };
    startDriverLoop({ intervalMs: 1000, maxTickMs: 0, tick });
    await vi.advanceTimersByTimeAsync(0); // tick 1 completes
    await vi.advanceTimersByTimeAsync(1000); // tick 2 starts and never resolves
    const hungAt = driverLoopStatus().lastTickAt;

    await vi.advanceTimersByTimeAsync(10_000); // no watchdog — loop stays wedged
    expect(driverLoopStatus().lastTickAt).toBe(hungAt);
    stopDriverLoop();
    vi.useRealTimers();
  });
});

describe("driverLoopStatus", () => {
  it("tracks running state, interval, and the last tick start time", async () => {
    vi.useFakeTimers();
    startDriverLoop({ intervalMs: 1000, maxTickMs: 0, tick: async () => {} });
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
});
