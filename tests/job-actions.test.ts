process.env.DRYDOCK_DB = ":memory:";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import {
  abortJobAction,
  bulkAbortJobsAction,
  bulkRequeueJobsAction,
  emergencyStopAction,
  requeueJobAction,
} from "@/lib/orchestrator/job-actions";
import { createJob, getJob, transitionJob } from "@/lib/orchestrator/jobs";
import { abortAllJobs, registerAbort } from "@/lib/orchestrator/singleton";
import { addRepo, updateRepo } from "@/lib/repos/service";
import { getSettings, saveSettings } from "@/lib/settings/service";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let repoId: number;
beforeEach(() => {
  abortAllJobs();
  repoId = addRepo({ path: "/r", name: "acme" }, getDb()).id;
  saveSettings({ paused: false });
});

describe("requeueJobAction", () => {
  it("requeues a needs_human job without touching the model by default", async () => {
    const db = getDb();
    const job = createJob({ repoId, issueNumber: 20, model: "claude-haiku-4-5" }, db);
    transitionJob(job.id, "working", {}, db);
    transitionJob(job.id, "needs_human", {}, db);

    const result = await requeueJobAction(job.id);

    expect(result.status).toBe("queued");
    expect(result.model).toBe("claude-haiku-4-5");
  });

  it("escalates the model when the repo opted in (issue #179)", async () => {
    const db = getDb();
    updateRepo(repoId, { escalateModelOnRetry: true }, db);
    const job = createJob({ repoId, issueNumber: 21, model: "claude-haiku-4-5" }, db);
    transitionJob(job.id, "working", {}, db);
    transitionJob(job.id, "needs_human", {}, db);

    const result = await requeueJobAction(job.id);

    expect(result.status).toBe("queued");
    expect(result.model).toBe("claude-sonnet-4-5");
    expect(getJob(job.id, db)?.model).toBe("claude-sonnet-4-5");
  });
});

describe("abortJobAction", () => {
  it("kills the running agent subprocess for an in-flight job", async () => {
    const db = getDb();
    const job = createJob({ repoId, issueNumber: 1 }, db);
    transitionJob(job.id, "working", {}, db);
    const abort = vi.fn();
    registerAbort(job.id, abort);

    await abortJobAction(job.id);

    expect(abort).toHaveBeenCalled();
  });

  it("transitions the job to aborted", async () => {
    const db = getDb();
    const job = createJob({ repoId, issueNumber: 2 }, db);
    transitionJob(job.id, "working", {}, db);
    registerAbort(job.id, vi.fn());

    const result = await abortJobAction(job.id);

    expect(result.status).toBe("aborted");
    expect(getJob(job.id, db)?.status).toBe("aborted");
  });

  it("still aborts a needs_human job that has no live subprocess", async () => {
    const db = getDb();
    const job = createJob({ repoId, issueNumber: 3 }, db);
    transitionJob(job.id, "working", {}, db);
    transitionJob(job.id, "needs_human", {}, db);

    const result = await abortJobAction(job.id);

    expect(result.status).toBe("aborted");
  });

  it("returns a merged job unchanged instead of throwing", async () => {
    const db = getDb();
    const job = createJob({ repoId, issueNumber: 4 }, db);
    transitionJob(job.id, "working", {}, db);
    transitionJob(job.id, "ci_running", {}, db);
    transitionJob(job.id, "merged", {}, db);

    const result = await abortJobAction(job.id);

    expect(result.status).toBe("merged");
    expect(getJob(job.id, db)?.status).toBe("merged");
  });

  it("is a no-op for a job that is already aborted", async () => {
    const db = getDb();
    const job = createJob({ repoId, issueNumber: 5 }, db);
    transitionJob(job.id, "working", {}, db);
    transitionJob(job.id, "aborted", {}, db);

    const result = await abortJobAction(job.id);

    expect(result.status).toBe("aborted");
  });
});

describe("bulkRequeueJobsAction (issue #410)", () => {
  function parkedJob(issueNumber: number) {
    const db = getDb();
    const job = createJob({ repoId, issueNumber }, db);
    transitionJob(job.id, "working", {}, db);
    transitionJob(job.id, "needs_human", {}, db);
    return job;
  }

  it("requeues every selected parked job and reports them all as succeeded", async () => {
    const db = getDb();
    const a = parkedJob(30);
    const b = parkedJob(31);
    const c = parkedJob(32);

    const result = await bulkRequeueJobsAction([a.id, b.id, c.id]);

    expect(result.succeeded).toEqual([a.id, b.id, c.id]);
    expect(result.failed).toEqual([]);
    expect(getJob(a.id, db)?.status).toBe("queued");
    expect(getJob(b.id, db)?.status).toBe("queued");
    expect(getJob(c.id, db)?.status).toBe("queued");
  });

  it("surfaces per-job failures without aborting the whole batch", async () => {
    const db = getDb();
    const good = parkedJob(33);
    const missing = 999_999;

    const result = await bulkRequeueJobsAction([good.id, missing]);

    expect(result.succeeded).toEqual([good.id]);
    expect(result.failed).toEqual([{ id: missing, error: `job ${missing} not found` }]);
    // The valid job was still requeued despite its neighbour failing.
    expect(getJob(good.id, db)?.status).toBe("queued");
  });

  it("returns an empty result for an empty selection", async () => {
    const result = await bulkRequeueJobsAction([]);

    expect(result).toEqual({ succeeded: [], failed: [] });
  });
});

describe("bulkAbortJobsAction (issue #410)", () => {
  function parkedJob(issueNumber: number) {
    const db = getDb();
    const job = createJob({ repoId, issueNumber }, db);
    transitionJob(job.id, "working", {}, db);
    transitionJob(job.id, "needs_human", {}, db);
    return job;
  }

  it("aborts every selected parked job and reports them all as succeeded", async () => {
    const db = getDb();
    const a = parkedJob(40);
    const b = parkedJob(41);

    const result = await bulkAbortJobsAction([a.id, b.id]);

    expect(result.succeeded).toEqual([a.id, b.id]);
    expect(result.failed).toEqual([]);
    expect(getJob(a.id, db)?.status).toBe("aborted");
    expect(getJob(b.id, db)?.status).toBe("aborted");
  });

  it("surfaces per-job failures without aborting the whole batch", async () => {
    const db = getDb();
    const good = parkedJob(42);
    const missing = 888_888;

    const result = await bulkAbortJobsAction([good.id, missing]);

    expect(result.succeeded).toEqual([good.id]);
    expect(result.failed).toEqual([{ id: missing, error: `job ${missing} not found` }]);
    expect(getJob(good.id, db)?.status).toBe("aborted");
  });

  it("returns an empty result for an empty selection", async () => {
    const result = await bulkAbortJobsAction([]);

    expect(result).toEqual({ succeeded: [], failed: [] });
  });
});

describe("emergencyStopAction", () => {
  it("pauses automation", async () => {
    await emergencyStopAction();

    expect(getSettings().paused).toBe(true);
  });

  it("aborts every running subprocess and marks those jobs aborted", async () => {
    const db = getDb();
    const a = createJob({ repoId, issueNumber: 10 }, db);
    const b = createJob({ repoId, issueNumber: 11 }, db);
    transitionJob(a.id, "working", {}, db);
    transitionJob(b.id, "working", {}, db);
    const abortA = vi.fn();
    const abortB = vi.fn();
    registerAbort(a.id, abortA);
    registerAbort(b.id, abortB);

    const result = await emergencyStopAction();

    expect(abortA).toHaveBeenCalled();
    expect(abortB).toHaveBeenCalled();
    expect(getJob(a.id, db)?.status).toBe("aborted");
    expect(getJob(b.id, db)?.status).toBe("aborted");
    expect(result.aborted).toBe(2);
  });

  it("is safe when no jobs are running", async () => {
    const result = await emergencyStopAction();

    expect(result.aborted).toBe(0);
    expect(getSettings().paused).toBe(true);
  });
});
