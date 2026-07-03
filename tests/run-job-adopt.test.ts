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

function fakeWorktrees(order: string[], over: Record<string, unknown> = {}) {
  return {
    prepare: vi.fn(async () => WT),
    commitAndPush: vi.fn(async () => {}),
    commitAndPushForHuman: vi.fn(async () => false),
    remove: vi.fn(async () => {
      order.push("remove");
    }),
    ...over,
  };
}

function deps(order: string[], over: Record<string, unknown> = {}) {
  const { worktrees: worktreesOver, ...rest } = over;
  return {
    db,
    worktrees: fakeWorktrees(order, (worktreesOver as Record<string, unknown>) ?? {}),
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
    announceNeedsHuman: vi.fn(async () => {}),
    notify: vi.fn(async () => {}),
    ...rest,
  };
}

describe("runJob claude-mem worktree adoption", () => {
  it("consolidates the job's memory into the parent by default, with no per-repo opt-in", async () => {
    const repo = addRepo({ path: "/r", name: "r" }, db);
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
    expect(adoptClaudeMem.mock.calls[0]?.[0]).toEqual({ branch: WT.branch, cwd: WT.path });
    // Adoption must run while the worktree still exists, before removal.
    expect(order).toEqual(["adopt", "remove"]);
  });

  it("consolidates a preserved needs_human worktree without removing it", async () => {
    const repo = addRepo({ path: "/r", name: "r" }, db);
    syncIssuesFromGh(repo.id, [{ number: 1, title: "T", labels: [] }], db);
    const order: string[] = [];
    const adoptClaudeMem = vi.fn(async (_input: { branch: string; cwd: string }) => {
      order.push("adopt");
    });
    const d = deps(order, {
      adoptClaudeMem,
      // Session fails, so the job parks for a human; a truthy commitAndPushForHuman
      // preserves the worktree (the branch it returns) instead of removing it.
      worktrees: { commitAndPushForHuman: vi.fn(async () => true) },
      runSession: vi.fn(async (job: Job) => {
        db.update(jobs).set({ status: "working" }).where(eq(jobs.id, job.id)).run();
        return { exitCode: 1, sessionId: "s1", costUsd: 0, inputTokens: 0, outputTokens: 0 };
      }),
    });
    const job = createJob({ repoId: repo.id, issueNumber: 1 }, db);

    const result = await runJob(job.id, d as never);

    expect(result.status).toBe("needs_human");
    // Memory is consolidated even though the worktree is preserved for resume.
    expect(adoptClaudeMem).toHaveBeenCalledTimes(1);
    expect(adoptClaudeMem.mock.calls[0]?.[0]).toEqual({ branch: WT.branch, cwd: WT.path });
    // The preserved worktree must NOT be removed.
    expect(d.worktrees.remove).not.toHaveBeenCalled();
    expect(order).toEqual(["adopt"]);
  });

  it("still removes the worktree when adoption throws", async () => {
    const repo = addRepo({ path: "/r", name: "r" }, db);
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
