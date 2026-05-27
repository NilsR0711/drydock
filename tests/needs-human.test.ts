import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { needsHumanJobs } from "@/lib/db/queries";
import { createJob, transitionJob } from "@/lib/orchestrator/jobs";
import { addRepo } from "@/lib/repos/service";

let db: DB;
let repoId: number;
beforeEach(() => {
  db = createDb(":memory:");
  repoId = addRepo({ path: "/r", name: "acme" }, db).id;
});

describe("needsHumanJobs", () => {
  it("returns only needs_human jobs with their repo name and error", () => {
    const job = createJob({ repoId, issueNumber: 7 }, db);
    transitionJob(job.id, "working", {}, db);
    transitionJob(job.id, "needs_human", { errorMessage: "boom" }, db);
    createJob({ repoId, issueNumber: 8 }, db); // stays queued

    const rows = needsHumanJobs(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.issueNumber).toBe(7);
    expect(rows[0]?.repoName).toBe("acme");
    expect(rows[0]?.errorMessage).toBe("boom");
  });

  it("requeue restores a needs_human job to queued", () => {
    const job = createJob({ repoId, issueNumber: 7 }, db);
    transitionJob(job.id, "working", {}, db);
    transitionJob(job.id, "needs_human", {}, db);
    const requeued = transitionJob(job.id, "queued", {}, db);
    expect(requeued.status).toBe("queued");
  });
});
