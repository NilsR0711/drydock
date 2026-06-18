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
      viewIssue: vi.fn(async () => ({ title: "", body: "" })),
      verify: vi.fn(async () => {
        order.push("verify");
      }),
      audit: vi.fn(async () => {
        order.push("audit");
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

describe("runJob PR audit hook (issue #168)", () => {
  it("runs the audit after the PR opens when opted in, after verification", async () => {
    const repo = addRepo({ path: "/r", name: "r", verifyPr: true, autoPrAudit: true }, db);
    syncIssuesFromGh(repo.id, [{ number: 1, title: "Big", labels: [] }], db);
    const { order, d } = deps();
    const job = createJob({ repoId: repo.id, issueNumber: 1 }, db);

    const result = await runJob(job.id, d as never);

    expect(result.status).toBe("merged");
    expect(d.audit).toHaveBeenCalledTimes(1);
    expect((d.audit as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toBe(55);
    expect(order).toEqual(["verify", "audit", "babysitter"]);
  });

  it("skips the audit when the repo has not opted in", async () => {
    const repo = addRepo({ path: "/r", name: "r", autoPrAudit: false }, db);
    syncIssuesFromGh(repo.id, [{ number: 1, title: "Big", labels: [] }], db);
    const { d } = deps();
    const job = createJob({ repoId: repo.id, issueNumber: 1 }, db);

    await runJob(job.id, d as never);

    expect(d.audit).not.toHaveBeenCalled();
  });

  it("does not corrupt the job when the audit throws", async () => {
    const repo = addRepo({ path: "/r", name: "r", autoPrAudit: true }, db);
    syncIssuesFromGh(repo.id, [{ number: 1, title: "Big", labels: [] }], db);
    const { d } = deps({
      audit: vi.fn(async () => {
        throw new Error("audit blew up");
      }),
    });
    const job = createJob({ repoId: repo.id, issueNumber: 1 }, db);

    const result = await runJob(job.id, d as never);

    expect(result.status).toBe("merged");
    expect(d.runBabysitter).toHaveBeenCalledTimes(1);
  });
});
