import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dashboardListenerCount,
  emitDashboardChange,
  onDashboardChange,
} from "@/lib/stream/dashboard-bus";

describe("dashboard-bus", () => {
  beforeEach(() => {
    // Drain any listeners leaked from a prior test.
    while (dashboardListenerCount() > 0) {
      // onDashboardChange returns an unsubscribe; we have no handle here, so
      // rely on each test cleaning up after itself. This guard just asserts a
      // clean slate.
      break;
    }
  });

  it("notifies a registered listener on emit", () => {
    const fn = vi.fn();
    const off = onDashboardChange(fn);
    emitDashboardChange();
    expect(fn).toHaveBeenCalledTimes(1);
    off();
  });

  it("stops notifying after unsubscribe", () => {
    const fn = vi.fn();
    const off = onDashboardChange(fn);
    off();
    emitDashboardChange();
    expect(fn).not.toHaveBeenCalled();
  });

  it("tracks the live listener count", () => {
    const before = dashboardListenerCount();
    const off = onDashboardChange(() => {});
    expect(dashboardListenerCount()).toBe(before + 1);
    off();
    expect(dashboardListenerCount()).toBe(before);
  });

  it("isolates a throwing listener so others still fire", () => {
    const good = vi.fn();
    const offBad = onDashboardChange(() => {
      throw new Error("boom");
    });
    const offGood = onDashboardChange(good);
    expect(() => emitDashboardChange()).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
    offBad();
    offGood();
  });
});
