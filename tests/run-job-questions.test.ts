import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { type Job, jobs } from "@/lib/db/schema";
import { EmptyCommitError, type Worktree } from "@/lib/git/worktree";
import { createJob, getJob } from "@/lib/orchestrator/jobs";
import { runJob } from "@/lib/orchestrator/run-job";
import { addRepo } from "@/lib/repos/service";

let db: DB;
let repoId: number;
beforeEach(() => {
  db = createDb(":memory:");
  repoId = addRepo({ verifyPr: false, autoPrAudit: false, path: "/repo", name: "acme" }, db).id;
});

/** A worktree stub whose commit/push/remove are spies; path "/wt" feeds readers. */
function fakeWorktrees(over: Record<string, unknown> = {}) {
  const wt: Worktree = { path: "/wt", branch: "drydock/issue-1-job-1" };
  return {
    prepare: vi.fn(async () => wt),
    commitAndPush: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    ...over,
  };
}

interface PrInput {
  head: string;
  base: string;
  title: string;
  body: string;
}

/** runJob deps that reach a clean session exit, with question-path spies. */
function baseDeps(over: Record<string, unknown> = {}) {
  const captured: { pr?: PrInput; comments: string[] } = { comments: [] };
  const deps = {
    db,
    worktrees: fakeWorktrees(),
    runSession: vi.fn(async (job: Job) => {
      db.update(jobs).set({ status: "working", sessionId: "s1" }).where(eq(jobs.id, job.id)).run();
      return { exitCode: 0, sessionId: "s1", costUsd: 0.1, inputTokens: 1, outputTokens: 1 };
    }),
    createPr: vi.fn(async (input: PrInput) => {
      captured.pr = input;
      return 55;
    }),
    viewIssue: vi.fn(async () => ({ title: "Issue title", body: "Issue body" })),
    commentIssue: vi.fn(async (_issueNumber: number, body: string) => {
      captured.comments.push(body);
    }),
    markNeedsHuman: vi.fn(async () => {}),
    runBabysitter: vi.fn(async (job: Job) => {
      db.update(jobs).set({ status: "merged" }).where(eq(jobs.id, job.id)).run();
      return getJob(job.id, db) as Job;
    }),
    ...over,
  };
  return { deps, captured };
}

describe("runJob — agent open questions (issue #251)", () => {
  it("parks in needs_human, preserves the branch, comments the questions, and labels", async () => {
    const consumeQuestions = vi.fn(() => "## Open questions\n- Per-user or global cache?");
    const { deps, captured } = baseDeps({ consumeQuestions });
    const job = createJob({ repoId, issueNumber: 1 }, db);

    const final = await runJob(job.id, deps as never);

    expect(consumeQuestions).toHaveBeenCalledWith("/wt");
    // Branch preserved: partial work committed + pushed before parking.
    expect(deps.worktrees.commitAndPush).toHaveBeenCalledTimes(1);
    // Questions handed to the human as an issue comment.
    expect(captured.comments.some((c) => c.includes("Per-user or global cache?"))).toBe(true);
    // needs-human label applied for the parked issue.
    expect(deps.markNeedsHuman).toHaveBeenCalledWith(1);
    // No PR opened, no babysitter run.
    expect(deps.createPr).not.toHaveBeenCalled();
    expect(deps.runBabysitter).not.toHaveBeenCalled();
    // Job parked with the explicit reason and the preserved branch recorded.
    expect(final.status).toBe("needs_human");
    expect(final.errorMessage).toBe("agent has open questions");
    expect(final.branch).toBe("drydock/issue-1-job-1");
  });

  it("still parks with questions when there is no partial work to commit", async () => {
    const consumeQuestions = vi.fn(() => "Need a product decision before continuing.");
    const worktrees = fakeWorktrees({
      commitAndPush: vi.fn(async () => {
        throw new EmptyCommitError();
      }),
    });
    const { deps, captured } = baseDeps({ consumeQuestions, worktrees });
    const job = createJob({ repoId, issueNumber: 2 }, db);

    const final = await runJob(job.id, deps as never);

    expect(captured.comments.some((c) => c.includes("product decision"))).toBe(true);
    expect(deps.markNeedsHuman).toHaveBeenCalledWith(2);
    expect(deps.createPr).not.toHaveBeenCalled();
    expect(final.status).toBe("needs_human");
    expect(final.errorMessage).toBe("agent has open questions");
    // No branch was ever pushed (EmptyCommitError), so the job must not record
    // one — a stale branch here breaks instruction-guided resume (issue #380).
    expect(final.branch).toBeNull();
  });

  it("opens a PR normally when no questions file is present", async () => {
    const consumeQuestions = vi.fn(() => null);
    const { deps, captured } = baseDeps({ consumeQuestions });
    const job = createJob({ repoId, issueNumber: 3 }, db);

    const final = await runJob(job.id, deps as never);

    expect(deps.markNeedsHuman).not.toHaveBeenCalled();
    expect(deps.createPr).toHaveBeenCalledTimes(1);
    expect(captured.pr?.body).toContain("Closes #3");
    expect(final.status).toBe("merged");
  });

  it("still parks when the breadcrumb comment or label call fails", async () => {
    const consumeQuestions = vi.fn(() => "Blocking question.");
    const { deps } = baseDeps({
      consumeQuestions,
      commentIssue: vi.fn(async () => {
        throw new Error("forge down");
      }),
      markNeedsHuman: vi.fn(async () => {
        throw new Error("label api down");
      }),
    });
    const job = createJob({ repoId, issueNumber: 4 }, db);

    const final = await runJob(job.id, deps as never);

    expect(final.status).toBe("needs_human");
    expect(final.errorMessage).toBe("agent has open questions");
    expect(deps.createPr).not.toHaveBeenCalled();
  });
});
