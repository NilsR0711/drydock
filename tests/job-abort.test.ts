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

  it("does nothing when no handles are registered", () => {
    const db = createDb(":memory:");
    expect(reconcileExternalAborts(db)).toEqual([]);
  });
});
