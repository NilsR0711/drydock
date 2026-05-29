process.env.DRYDOCK_DB = ":memory:";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { abortJobAction, emergencyStopAction } from "@/lib/orchestrator/job-actions";
import { createJob, getJob, transitionJob } from "@/lib/orchestrator/jobs";
import { abortAllJobs, registerAbort } from "@/lib/orchestrator/singleton";
import { addRepo } from "@/lib/repos/service";
import { getSettings, saveSettings } from "@/lib/settings/service";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let repoId: number;
beforeEach(() => {
  abortAllJobs();
  repoId = addRepo({ path: "/r", name: "acme" }, getDb()).id;
  saveSettings({ paused: false });
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
