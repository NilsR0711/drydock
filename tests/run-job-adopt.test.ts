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

const WT: Worktree = { path: "/wt", branch: "drydock/issue-1-job-1" };

function fakeWorktrees(order: string[]) {
  return {
    prepare: vi.fn(async () => WT),
    commitAndPush: vi.fn(async () => {}),
    commitAndPushForHuman: vi.fn(async () => false),
    remove: vi.fn(async () => {
      order.push("remove");
    }),
  };
}

function deps(order: string[], over: Record<string, unknown> = {}) {
  return {
    db,
    worktrees: fakeWorktrees(order),
    runSession: vi.fn(async (job: Job) => {
      db.update(jobs).set({ status: "working", sessionId: "s1" }).where(eq(jobs.id, job.id)).run();
      return { exitCode: 0, sessionId: "s1", costUsd: 0.1, inputTokens: 1, outputTokens: 1 };
    }),
    createPr: vi.fn(async () => 55),
    viewIssue: vi.fn(async () => ({ title: "", body: "" })),
    verify: vi.fn(async () => {}),
    audit: vi.fn(async () => {}),
    runBabysitter: vi.fn(async (job: Job) => {
      db.update(jobs).set({ status: "merged" }).where(eq(jobs.id, job.id)).run();
      return getJob(job.id, db) as Job;
    }),
    notify: vi.fn(async () => {}),
    ...over,
  };
}

describe("runJob claude-mem worktree adoption", () => {
  it("does not invoke adoption when the repo has not opted in", async () => {
    const repo = addRepo({ path: "/r", name: "r" }, db);
    syncIssuesFromGh(repo.id, [{ number: 1, title: "T", labels: [] }], db);
    const order: string[] = [];
    const adoptClaudeMem = vi.fn(async () => {});
    const d = deps(order, { adoptClaudeMem });
    const job = createJob({ repoId: repo.id, issueNumber: 1 }, db);

    const result = await runJob(job.id, d as never);

    expect(result.status).toBe("merged");
    expect(adoptClaudeMem).not.toHaveBeenCalled();
    expect(d.worktrees.remove).toHaveBeenCalledTimes(1);
  });

  it("invokes adoption with the job's branch and worktree path before removal when opted in", async () => {
    const repo = addRepo({ path: "/r", name: "r", adoptClaudeMem: true }, db);
    syncIssuesFromGh(repo.id, [{ number: 1, title: "T", labels: [] }], db);
    const order: string[] = [];
    const adoptClaudeMem = vi.fn(async (_input: { branch: string; cwd: string }) => {
      order.push("adopt");
    });
    const d = deps(order, { adoptClaudeMem });
    const job = createJob({ repoId: repo.id, issueNumber: 1 }, db);

    const result = await runJob(job.id, d as never);

    expect(result.status).toBe("merged");
    expect(adoptClaudeMem).toHaveBeenCalledTimes(1);
    expect(adoptClaudeMem.mock.calls[0]?.[0]).toEqual({
      branch: WT.branch,
      cwd: WT.path,
    });
    // Adoption must run while the worktree still exists.
    expect(order).toEqual(["adopt", "remove"]);
  });

  it("still removes the worktree when adoption throws", async () => {
    const repo = addRepo({ path: "/r", name: "r", adoptClaudeMem: true }, db);
    syncIssuesFromGh(repo.id, [{ number: 1, title: "T", labels: [] }], db);
    const order: string[] = [];
    const adoptClaudeMem = vi.fn(async () => {
      throw new Error("adoption blew up");
    });
    const d = deps(order, { adoptClaudeMem });
    const job = createJob({ repoId: repo.id, issueNumber: 1 }, db);

    const result = await runJob(job.id, d as never);

    expect(result.status).toBe("merged");
    expect(adoptClaudeMem).toHaveBeenCalledTimes(1);
    expect(d.worktrees.remove).toHaveBeenCalledTimes(1);
  });
});
