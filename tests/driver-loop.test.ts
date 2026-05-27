import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { type Job, jobs } from "@/lib/db/schema";
import { reorderIssues, syncIssuesFromGh } from "@/lib/issues/service";
import { driveTick } from "@/lib/orchestrator/driver-loop";
import { createJob, getJob, listJobsByStatus } from "@/lib/orchestrator/jobs";
import { setDrainMode } from "@/lib/orchestrator/runtime";
import { addRepo } from "@/lib/repos/service";
import { saveSettings } from "@/lib/settings/service";

let db: DB;
let repoId: number;
beforeEach(() => {
  db = createDb(":memory:");
  repoId = addRepo(
    { path: "/repo", name: "acme", defaultModel: "claude-opus-4-7", sequential: false },
    db,
  ).id;
  setDrainMode(false);
});

function deps(started: number[], over: Record<string, unknown> = {}) {
  return {
    db,
    fetchIssues: vi.fn(async () => []),
    runJob: vi.fn(async (jobId: number) => {
      started.push(jobId);
      db.update(jobs).set({ status: "merged" }).where(eq(jobs.id, jobId)).run();
      return db.select().from(jobs).where(eq(jobs.id, jobId)).get() as Job;
    }),
    ...over,
  };
}

describe("driveTick", () => {
  it("starts queued jobs up to maxParallelJobs, lowest issue priority first", async () => {
    saveSettings({ maxParallelJobs: 2 }, db);
    syncIssuesFromGh(
      repoId,
      [
        { number: 10, title: "#10", labels: [] },
        { number: 20, title: "#20", labels: [] },
        { number: 30, title: "#30", labels: [] },
      ],
      db,
    );
    reorderIssues(repoId, [30, 20, 10], db); // 30 highest priority
    createJob({ repoId, issueNumber: 10 }, db);
    createJob({ repoId, issueNumber: 20 }, db);
    createJob({ repoId, issueNumber: 30 }, db);
    const started: number[] = [];
    // fetch returns the same issues so the sync phase keeps their priorities
    const d = deps(started, {
      fetchIssues: vi.fn(async () => [
        { number: 10, title: "#10", labels: [] },
        { number: 20, title: "#20", labels: [] },
        { number: 30, title: "#30", labels: [] },
      ]),
    });
    await driveTick(d as never);
    expect(started.length).toBe(2); // capped at maxParallelJobs
    const issue30Job = db.select().from(jobs).where(eq(jobs.issueNumber, 30)).get() as Job;
    expect(started[0]).toBe(issue30Job.id);
  });

  it("skips a repo over its cost limit but starts another repo's job", async () => {
    const repoA = addRepo({ path: "/a", name: "a", dailyCostLimitUsd: 1 }, db).id;
    const repoB = addRepo({ path: "/b", name: "b", dailyCostLimitUsd: 100 }, db).id;
    const now = Math.floor(Date.now() / 1000);
    // repoA already spent over its limit today
    db.insert(jobs)
      .values({ repoId: repoA, issueNumber: 99, status: "merged", startedAt: now, costUsd: 5 })
      .run();
    const jobA = createJob({ repoId: repoA, issueNumber: 1 }, db);
    const jobB = createJob({ repoId: repoB, issueNumber: 2 }, db);
    const started: number[] = [];
    await driveTick(deps(started) as never);
    expect(started).toContain(jobB.id);
    expect(started).not.toContain(jobA.id);
    expect(db.select().from(jobs).where(eq(jobs.id, jobA.id)).get()?.status).toBe("queued");
  });

  it("starts nothing when paused", async () => {
    saveSettings({ paused: true }, db);
    createJob({ repoId, issueNumber: 1 }, db);
    const started: number[] = [];
    await driveTick(deps(started) as never);
    expect(started).toEqual([]);
  });

  it("starts nothing while draining", async () => {
    setDrainMode(true);
    createJob({ repoId, issueNumber: 1 }, db);
    const started: number[] = [];
    await driveTick(deps(started) as never);
    expect(started).toEqual([]);
  });

  it("enqueues approved labelled issues and skips risky ones", async () => {
    const started: number[] = [];
    const d = deps(started, {
      fetchIssues: vi.fn(async () => [
        { number: 1, title: "ok", labels: [{ name: "drydock:queue" }] },
        { number: 2, title: "rm -rf /", labels: [{ name: "drydock:queue" }] },
      ]),
    });
    await driveTick(d as never);
    const seen = listJobsByStatus(["queued", "merged"], db);
    expect(seen.some((j) => j.issueNumber === 1)).toBe(true);
    expect(seen.some((j) => j.issueNumber === 2)).toBe(false);
  });

  it("sequential repo starts only one in-flight job at a time", async () => {
    saveSettings({ maxParallelJobs: 5 }, db);
    const seqRepo = addRepo({ path: "/seq", name: "seq", sequential: true }, db).id;
    const fetchIssues = vi.fn(async () => [
      { number: 1, title: "one", labels: [{ name: "drydock:queue" }] },
      { number: 2, title: "two", labels: [{ name: "drydock:queue" }] },
    ]);
    const started: number[] = [];
    // runJob leaves the job in "working" (in-flight, not terminal)
    const runJob = vi.fn(async (jobId: number) => {
      started.push(jobId);
      return getJob(jobId, db) as Job;
    });
    await driveTick({ db, fetchIssues, runJob } as never);
    const seqStarted = started.filter((id) => getJob(id, db)?.repoId === seqRepo);
    expect(seqStarted).toHaveLength(1);
  });

  it("parallel repo starts multiple jobs up to the budget", async () => {
    saveSettings({ maxParallelJobs: 5 }, db);
    const parRepo = addRepo({ path: "/par", name: "par", sequential: false }, db).id;
    const fetchIssues = vi.fn(async (path: string) =>
      path === "/par"
        ? [
            { number: 1, title: "one", labels: [{ name: "drydock:queue" }] },
            { number: 2, title: "two", labels: [{ name: "drydock:queue" }] },
          ]
        : [],
    );
    const started: number[] = [];
    const runJob = vi.fn(async (jobId: number) => {
      started.push(jobId);
      return getJob(jobId, db) as Job;
    });
    await driveTick({ db, fetchIssues, runJob } as never);
    const parStarted = started.filter((id) => getJob(id, db)?.repoId === parRepo);
    expect(parStarted.length).toBeGreaterThanOrEqual(2);
  });

  it("swallows a runJob error so the loop survives", async () => {
    createJob({ repoId, issueNumber: 1 }, db);
    const d = deps([], {
      runJob: vi.fn(async () => {
        throw new Error("kaboom");
      }),
    });
    await expect(driveTick(d as never)).resolves.toBeUndefined();
  });
});
