import { afterEach, describe, expect, it, vi } from "vitest";
import { startDriverLoop, stopDriverLoop } from "@/lib/orchestrator/driver-loop";

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
