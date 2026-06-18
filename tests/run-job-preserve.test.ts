import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { type Job, jobs } from "@/lib/db/schema";
import type { Worktree } from "@/lib/git/worktree";
import { createJob, getJob, transitionJob } from "@/lib/orchestrator/jobs";
import { runJob } from "@/lib/orchestrator/run-job";
import { addRepo } from "@/lib/repos/service";

// Issue #249: when a job parks in needs_human with real work in its worktree,
// Drydock must commit + push the branch, record it on the job row, and keep the
// worktree instead of discarding the agent's commits. A genuine no-op run still
// cleans up.

let db: DB;
let repoId: number;
beforeEach(() => {
  db = createDb(":memory:");
  repoId = addRepo({ path: "/repo", name: "acme", defaultModel: "claude-opus-4-7" }, db).id;
});

function fakeWorktrees(removed: { v: boolean }, over: Record<string, unknown> = {}) {
  const wt: Worktree = { path: "/wt", branch: "drydock/issue-1-job-1", base: "base000" };
  return {
    prepare: vi.fn(async () => wt),
    commitAndPush: vi.fn(async () => {}),
    commitAndPushForHuman: vi.fn(async () => true),
    remove: vi.fn(async () => {
      removed.v = true;
    }),
    ...over,
  };
}

/** A session that exits non-zero so the run parks in needs_human pre-PR. */
function failingSession() {
  return vi.fn(async (job: Job) => {
    db.update(jobs).set({ status: "working" }).where(eq(jobs.id, job.id)).run();
    return { exitCode: 1, sessionId: "s1", costUsd: 0, inputTokens: 0, outputTokens: 0 };
  });
}

function baseDeps(removed: { v: boolean }, over: Record<string, unknown> = {}) {
  return {
    db,
    worktrees: fakeWorktrees(removed),
    runSession: failingSession(),
    createPr: vi.fn(async () => 55),
    viewIssue: vi.fn(async () => ({ title: "", body: "" })),
    ...over,
  };
}

describe("runJob needs_human worktree preservation (issue #249)", () => {
  it("commits, pushes and records the branch, keeping the worktree, when a parked job has work", async () => {
    const removed = { v: false };
    const deps = baseDeps(removed);
    const job = createJob({ repoId, issueNumber: 1 }, db);
    const result = await runJob(job.id, deps as never);

    expect(result.status).toBe("needs_human");
    expect(deps.worktrees.commitAndPushForHuman).toHaveBeenCalledTimes(1);
    // The recorded branch lets the job detail page link the preserved work.
    expect(result.branch).toBe("drydock/issue-1-job-1");
    // The worktree (and its commits) survive for a human or a later resume.
    expect(removed.v).toBe(false);
    expect(deps.worktrees.remove).not.toHaveBeenCalled();
  });

  it("still cleans up and records no branch when the parked run produced no work", async () => {
    const removed = { v: false };
    const deps = baseDeps(removed, {
      worktrees: fakeWorktrees(removed, { commitAndPushForHuman: vi.fn(async () => false) }),
    });
    const job = createJob({ repoId, issueNumber: 1 }, db);
    const result = await runJob(job.id, deps as never);

    expect(result.status).toBe("needs_human");
    expect(deps.worktrees.commitAndPushForHuman).toHaveBeenCalledTimes(1);
    expect(result.branch).toBeNull();
    expect(removed.v).toBe(true);
  });

  it("keeps the worktree even when the preserve push fails, so work is not discarded", async () => {
    const removed = { v: false };
    const deps = baseDeps(removed, {
      worktrees: fakeWorktrees(removed, {
        commitAndPushForHuman: vi.fn(async () => {
          throw new Error("push rejected");
        }),
      }),
    });
    const job = createJob({ repoId, issueNumber: 1 }, db);
    const result = await runJob(job.id, deps as never);

    expect(result.status).toBe("needs_human");
    // A failed push cannot record a branch, but the local worktree is kept so
    // the committed work survives for manual recovery.
    expect(result.branch).toBeNull();
    expect(removed.v).toBe(false);
  });

  it("preserves the worktree when a throw parks a post-session job in needs_human", async () => {
    const removed = { v: false };
    const deps = baseDeps(removed, {
      runSession: vi.fn(async (job: Job) => {
        db.update(jobs)
          .set({ status: "working", sessionId: "s1" })
          .where(eq(jobs.id, job.id))
          .run();
        return { exitCode: 0, sessionId: "s1", costUsd: 0.1, inputTokens: 1, outputTokens: 1 };
      }),
      commitAndPush: vi.fn(),
      createPr: vi.fn(async () => {
        throw new Error("createPr boom");
      }),
      worktrees: fakeWorktrees(removed, { commitAndPush: vi.fn(async () => {}) }),
    });
    const job = createJob({ repoId, issueNumber: 1 }, db);
    const result = await runJob(job.id, deps as never);

    expect(result.status).toBe("needs_human");
    expect(result.errorMessage).toContain("createPr boom");
    expect(removed.v).toBe(false);
    expect(result.branch).toBe("drydock/issue-1-job-1");
  });

  it("removes the worktree on a successful merge (no preservation on the happy path)", async () => {
    const removed = { v: false };
    const deps = baseDeps(removed, {
      runSession: vi.fn(async (job: Job) => {
        db.update(jobs)
          .set({ status: "working", sessionId: "s1" })
          .where(eq(jobs.id, job.id))
          .run();
        return { exitCode: 0, sessionId: "s1", costUsd: 0.1, inputTokens: 1, outputTokens: 1 };
      }),
      runBabysitter: vi.fn(async (job: Job) => {
        db.update(jobs).set({ status: "merged" }).where(eq(jobs.id, job.id)).run();
        return getJob(job.id, db) as Job;
      }),
    });
    const job = createJob({ repoId, issueNumber: 1 }, db);
    const result = await runJob(job.id, deps as never);

    expect(result.status).toBe("merged");
    expect(deps.worktrees.commitAndPushForHuman).not.toHaveBeenCalled();
    expect(removed.v).toBe(true);
  });

  it("does not preserve when an external abort settles the job", async () => {
    const removed = { v: false };
    const deps = baseDeps(removed, {
      runBabysitter: vi.fn(async (job: Job) => {
        transitionJob(job.id, "aborted", {}, db);
        throw new Error("SIGTERM");
      }),
      runSession: vi.fn(async (job: Job) => {
        db.update(jobs)
          .set({ status: "working", sessionId: "s1" })
          .where(eq(jobs.id, job.id))
          .run();
        return { exitCode: 0, sessionId: "s1", costUsd: 0.1, inputTokens: 1, outputTokens: 1 };
      }),
      worktrees: fakeWorktrees(removed, { commitAndPush: vi.fn(async () => {}) }),
    });
    const job = createJob({ repoId, issueNumber: 1 }, db);
    const result = await runJob(job.id, deps as never);

    expect(result.status).toBe("aborted");
    expect(deps.worktrees.commitAndPushForHuman).not.toHaveBeenCalled();
    expect(removed.v).toBe(true);
  });

  it("cleans up when a concurrent abort makes the needs_human transition throw mid-preserve", async () => {
    // The catch path preserves the worktree, then the needs_human transition
    // races a concurrent abort and throws InvalidTransitionError. The job is now
    // terminal, so the preserve must be undone and the worktree cleaned up
    // instead of leaking (CodeRabbit, issue #249).
    const removed = { v: false };
    const deps = baseDeps(removed, {
      runSession: vi.fn(async (job: Job) => {
        db.update(jobs)
          .set({ status: "working", sessionId: "s1" })
          .where(eq(jobs.id, job.id))
          .run();
        return { exitCode: 0, sessionId: "s1", costUsd: 0.1, inputTokens: 1, outputTokens: 1 };
      }),
      worktrees: fakeWorktrees(removed, {
        // The PR-path commit fails, dropping into the catch with status working.
        commitAndPush: vi.fn(async () => {
          throw new Error("boom");
        }),
        // Preserve flips the flag true, but an abort lands first: the subsequent
        // needs_human transition then throws InvalidTransitionError.
        commitAndPushForHuman: vi.fn(async () => {
          transitionJob(job.id, "aborted", {}, db);
          return true;
        }),
      }),
    });
    const job = createJob({ repoId, issueNumber: 1 }, db);
    const result = await runJob(job.id, deps as never);

    expect(result.status).toBe("aborted");
    expect(deps.worktrees.commitAndPushForHuman).toHaveBeenCalledTimes(1);
    expect(removed.v).toBe(true);
  });
});
