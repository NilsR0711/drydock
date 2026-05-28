import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { type Job, jobs } from "@/lib/db/schema";
import type { Worktree } from "@/lib/git/worktree";
import { syncIssuesFromGh } from "@/lib/issues/service";
import { createJob, getJob } from "@/lib/orchestrator/jobs";
import { runJob } from "@/lib/orchestrator/run-job";
import { addRepo } from "@/lib/repos/service";

let db: DB;
beforeEach(() => {
  db = createDb(":memory:");
});

function fakeWorktrees() {
  const wt: Worktree = { path: "/wt", branch: "drydock/issue-1-job-1" };
  return {
    prepare: vi.fn(async () => wt),
    commitAndPush: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  };
}

function deps(over: Record<string, unknown> = {}) {
  const order: string[] = [];
  return {
    order,
    d: {
      db,
      worktrees: fakeWorktrees(),
      runSession: vi.fn(async (job: Job) => {
        db.update(jobs)
          .set({ status: "working", sessionId: "s1" })
          .where(eq(jobs.id, job.id))
          .run();
        return { exitCode: 0, sessionId: "s1", costUsd: 0.1, inputTokens: 1, outputTokens: 1 };
      }),
      createPr: vi.fn(async () => 55),
      verify: vi.fn(async () => {
        order.push("verify");
      }),
      runBabysitter: vi.fn(async (job: Job) => {
        order.push("babysitter");
        db.update(jobs).set({ status: "merged" }).where(eq(jobs.id, job.id)).run();
        return getJob(job.id, db) as Job;
      }),
      notify: vi.fn(async () => {}),
      ...over,
    },
  };
}

describe("runJob post-PR verification", () => {
  it("runs verification after the PR opens and before the babysitter when opted in", async () => {
    const repo = addRepo({ path: "/r", name: "r", verifyPr: true }, db);
    syncIssuesFromGh(repo.id, [{ number: 1, title: "Big", labels: [] }], db);
    const { order, d } = deps();
    const job = createJob({ repoId: repo.id, issueNumber: 1 }, db);

    const result = await runJob(job.id, d as never);

    expect(result.status).toBe("merged");
    expect(d.verify).toHaveBeenCalledTimes(1);
    expect((d.verify as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toBe(55);
    expect(order).toEqual(["verify", "babysitter"]);
  });

  it("skips verification when the repo has not opted in", async () => {
    const repo = addRepo({ path: "/r", name: "r", verifyPr: false }, db);
    syncIssuesFromGh(repo.id, [{ number: 1, title: "Big", labels: [] }], db);
    const { d } = deps();
    const job = createJob({ repoId: repo.id, issueNumber: 1 }, db);

    await runJob(job.id, d as never);

    expect(d.verify).not.toHaveBeenCalled();
  });

  it("does not corrupt the job when verification throws", async () => {
    const repo = addRepo({ path: "/r", name: "r", verifyPr: true }, db);
    syncIssuesFromGh(repo.id, [{ number: 1, title: "Big", labels: [] }], db);
    const { d } = deps({
      verify: vi.fn(async () => {
        throw new Error("verification blew up");
      }),
    });
    const job = createJob({ repoId: repo.id, issueNumber: 1 }, db);

    const result = await runJob(job.id, d as never);

    expect(result.status).toBe("merged");
    expect(d.runBabysitter).toHaveBeenCalledTimes(1);
  });
});
