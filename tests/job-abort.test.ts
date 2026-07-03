import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "@/lib/db/client";
import { repos } from "@/lib/db/schema";
import { createJob, transitionJob } from "@/lib/orchestrator/jobs";
import {
  abortAllJobs,
  abortJob,
  clearAbort,
  reconcileExternalAborts,
  registerAbort,
} from "@/lib/orchestrator/singleton";

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
    clearAbort(4, abort);

    expect(abortJob(4)).toBe(false);
    expect(abort).not.toHaveBeenCalled();
  });

  it("invokes every handle registered for the same job id", () => {
    const first = vi.fn();
    const second = vi.fn();
    registerAbort(5, first);
    registerAbort(5, second);

    expect(abortJob(5)).toBe(true);
    expect(first).toHaveBeenCalledWith(5000);
    expect(second).toHaveBeenCalledWith(5000);
  });

  it("fires the surviving siblings even when one abort handle throws", () => {
    const boom = vi.fn(() => {
      throw new Error("kill failed");
    });
    const survivor = vi.fn();
    registerAbort(6, boom);
    registerAbort(6, survivor);

    expect(abortJob(6)).toBe(true);
    expect(survivor).toHaveBeenCalledWith(5000);
  });
});

// The registry stores at most one handle per job id no longer: two agent
// sessions can legitimately run at once for the same job — the CI babysitter's
// fix resume and a review-feedback side session on the same PR. The old
// single-slot Map let the second registration overwrite the first, and whichever
// session finished first deleted whatever handle was in the slot, orphaning a
// still-running subprocess that no kill switch could reach (issue #384).
describe("concurrent sessions for one job id (issue #384)", () => {
  it("keeps both handles registered so abortJob terminates every live session", () => {
    const resume = vi.fn();
    const sideSession = vi.fn();
    registerAbort(20, resume);
    registerAbort(20, sideSession);

    expect(abortJob(20)).toBe(true);
    expect(resume).toHaveBeenCalledWith(5000);
    expect(sideSession).toHaveBeenCalledWith(5000);
  });

  it("a session finishing removes only its own handle; the other stays abortable", () => {
    const resume = vi.fn();
    const sideSession = vi.fn();
    registerAbort(21, resume);
    const disposeSide = registerAbort(21, sideSession);

    disposeSide(); // the side session ends first and disposes its own handle

    expect(abortJob(21)).toBe(true);
    expect(resume).toHaveBeenCalledWith(5000);
    expect(sideSession).not.toHaveBeenCalled();
  });

  it("clearing the second registration leaves the first firing (overwrite regression)", () => {
    // Register A, register B, clear B → A must still fire. Under the old
    // single-slot Map, B overwrote A and clearing B emptied the slot, so A's
    // subprocess was orphaned.
    const a = vi.fn();
    const b = vi.fn();
    registerAbort(22, a);
    const disposeB = registerAbort(22, b);

    disposeB();

    expect(abortJob(22)).toBe(true);
    expect(a).toHaveBeenCalledWith(5000);
    expect(b).not.toHaveBeenCalled();
  });

  it("disposing a handle twice is a no-op and never touches a sibling", () => {
    const a = vi.fn();
    const b = vi.fn();
    const disposeA = registerAbort(23, a);
    registerAbort(23, b);

    disposeA();
    disposeA(); // idempotent

    expect(abortJob(23)).toBe(true);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith(5000);
  });

  it("a disposer left over after abortJob drained the set is a safe no-op", () => {
    const a = vi.fn();
    const disposeA = registerAbort(24, a);

    abortJob(24); // drains and deletes the set

    expect(() => disposeA()).not.toThrow();
    // A fresh registration for the same id is unaffected by the stale disposer.
    const b = vi.fn();
    registerAbort(24, b);
    disposeA();
    expect(abortJob(24)).toBe(true);
    expect(b).toHaveBeenCalledWith(5000);
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

  it("invokes every handle when a job id carries more than one session", () => {
    const resume = vi.fn();
    const sideSession = vi.fn();
    const other = vi.fn();
    registerAbort(13, resume);
    registerAbort(13, sideSession);
    registerAbort(14, other);

    const ids = abortAllJobs();

    expect(ids.sort((x, y) => x - y)).toEqual([13, 14]);
    expect(resume).toHaveBeenCalledWith(5000);
    expect(sideSession).toHaveBeenCalledWith(5000);
    expect(other).toHaveBeenCalledWith(5000);
  });
});

describe("cross-layer registry sharing (issue #232 pattern)", () => {
  it("finds a handle registered by a separately-evaluated module instance", async () => {
    // Next.js compiles Server Actions and the orchestrator into separate bundle
    // layers that evaluate this module independently. `vi.resetModules()` plus a
    // fresh dynamic import reproduces that: a second module instance whose own
    // closures are brand new. The abort registry must still be shared (it lives
    // on globalThis), or the Stop action's `abortJob` would never see the handle
    // the orchestrator layer registered — the job would flip to aborted while
    // its subprocess kept running.
    const orchestratorLayer = await import("@/lib/orchestrator/singleton");
    const abort = vi.fn();
    orchestratorLayer.registerAbort(777, abort);

    vi.resetModules();
    const actionLayer = await import("@/lib/orchestrator/singleton");

    expect(actionLayer.abortJob(777)).toBe(true);
    expect(abort).toHaveBeenCalledWith(5000);
  });
});

describe("reconcileExternalAborts", () => {
  it("kills only handles whose job row was flipped to aborted by another process", () => {
    const db = createDb(":memory:");
    const repo = db.insert(repos).values({ path: "/r", name: "r" }).returning().get();

    // Simulates the MCP server's abort_job: the row is aborted in the DB while
    // this process still holds a live subprocess handle for the job.
    const abortedJob = createJob({ repoId: repo.id, issueNumber: 1 }, db);
    transitionJob(abortedJob.id, "working", {}, db);
    transitionJob(abortedJob.id, "aborted", {}, db);
    const runningJob = createJob({ repoId: repo.id, issueNumber: 2 }, db);
    transitionJob(runningJob.id, "working", {}, db);

    const killAborted = vi.fn();
    const killRunning = vi.fn();
    registerAbort(abortedJob.id, killAborted);
    registerAbort(runningJob.id, killRunning);

    const killed = reconcileExternalAborts(db);

    expect(killed).toEqual([abortedJob.id]);
    expect(killAborted).toHaveBeenCalledWith(5000);
    expect(killRunning).not.toHaveBeenCalled();
  });

  it("consumes the handle so a second reconcile is a no-op", () => {
    const db = createDb(":memory:");
    const repo = db.insert(repos).values({ path: "/r", name: "r" }).returning().get();
    const job = createJob({ repoId: repo.id, issueNumber: 3 }, db);
    transitionJob(job.id, "aborted", {}, db);
    registerAbort(job.id, vi.fn());

    expect(reconcileExternalAborts(db)).toEqual([job.id]);
    expect(reconcileExternalAborts(db)).toEqual([]);
  });

  it("kills every handle registered for an externally-aborted job", () => {
    const db = createDb(":memory:");
    const repo = db.insert(repos).values({ path: "/r", name: "r" }).returning().get();
    const job = createJob({ repoId: repo.id, issueNumber: 4 }, db);
    transitionJob(job.id, "working", {}, db);
    transitionJob(job.id, "aborted", {}, db);

    const resume = vi.fn();
    const sideSession = vi.fn();
    registerAbort(job.id, resume);
    registerAbort(job.id, sideSession);

    expect(reconcileExternalAborts(db)).toEqual([job.id]);
    expect(resume).toHaveBeenCalledWith(5000);
    expect(sideSession).toHaveBeenCalledWith(5000);
  });

  it("does nothing when no handles are registered", () => {
    const db = createDb(":memory:");
    expect(reconcileExternalAborts(db)).toEqual([]);
  });
});
