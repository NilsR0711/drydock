import { beforeEach, describe, expect, it, vi } from "vitest";
import { abortAllJobs, abortJob, clearAbort, registerAbort } from "@/lib/orchestrator/singleton";

// The abort registry is module-level state shared with the agent sessions.
// Clear any leftover handles between tests so counts are deterministic.
beforeEach(() => {
  abortAllJobs();
});

describe("abortJob", () => {
  it("invokes the registered abort handle and reports it was found", () => {
    const abort = vi.fn();
    registerAbort(1, abort);

    const found = abortJob(1);

    expect(found).toBe(true);
    expect(abort).toHaveBeenCalledWith(5000);
  });

  it("forwards a custom grace window to the handle", () => {
    const abort = vi.fn();
    registerAbort(2, abort);

    abortJob(2, 1000);

    expect(abort).toHaveBeenCalledWith(1000);
  });

  it("removes the handle so a second abort is a no-op", () => {
    const abort = vi.fn();
    registerAbort(3, abort);

    abortJob(3);
    const second = abortJob(3);

    expect(second).toBe(false);
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("returns false when no handle is registered for the job", () => {
    expect(abortJob(999)).toBe(false);
  });

  it("does not invoke a handle that was already cleared", () => {
    const abort = vi.fn();
    registerAbort(4, abort);
    clearAbort(4);

    expect(abortJob(4)).toBe(false);
    expect(abort).not.toHaveBeenCalled();
  });
});

describe("abortAllJobs", () => {
  it("invokes every registered handle and returns their job ids", () => {
    const a = vi.fn();
    const b = vi.fn();
    registerAbort(10, a);
    registerAbort(11, b);

    const ids = abortAllJobs();

    expect(ids.sort((x, y) => x - y)).toEqual([10, 11]);
    expect(a).toHaveBeenCalledWith(5000);
    expect(b).toHaveBeenCalledWith(5000);
  });

  it("clears the registry so a subsequent call aborts nothing", () => {
    registerAbort(12, vi.fn());

    abortAllJobs();
    const ids = abortAllJobs();

    expect(ids).toEqual([]);
  });

  it("returns an empty list when nothing is running", () => {
    expect(abortAllJobs()).toEqual([]);
  });
});
