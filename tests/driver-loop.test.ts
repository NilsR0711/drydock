import { type DB, createDb } from "@/lib/db/client";
import { type Job, jobs } from "@/lib/db/schema";
import { driveTick } from "@/lib/orchestrator/driver-loop";
import { createJob, listJobsByStatus } from "@/lib/orchestrator/jobs";
import { setDrainMode } from "@/lib/orchestrator/runtime";
import { addRepo } from "@/lib/repos/service";
import { saveSettings } from "@/lib/settings/service";
import { reorderIssues, syncIssuesFromGh } from "@/lib/issues/service";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

let db: DB;
let repoId: number;
beforeEach(() => {
  db = createDb(":memory:");
  repoId = addRepo({ path: "/repo", name: "acme", defaultModel: "claude-opus-4-7" }, db).id;
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
    syncIssuesFromGh(repoId, [
      { number: 10, title: "#10", labels: [] },
      { number: 20, title: "#20", labels: [] },
      { number: 30, title: "#30", labels: [] },
    ], db);
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
        { number: 1, title: "ok", labels: [{ name: "autoclaude:queue" }] },
        { number: 2, title: "rm -rf /", labels: [{ name: "autoclaude:queue" }] },
      ]),
    });
    await driveTick(d as never);
    const seen = listJobsByStatus(["queued", "merged"], db);
    expect(seen.some((j) => j.issueNumber === 1)).toBe(true);
    expect(seen.some((j) => j.issueNumber === 2)).toBe(false);
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
