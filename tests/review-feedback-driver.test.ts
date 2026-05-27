import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import type { Job, Repo } from "@/lib/db/schema";
import type { ForgeClient, ReviewThread } from "@/lib/forge/types";
import { createJob, transitionJob } from "@/lib/orchestrator/jobs";
import { buildAgentApply, driveReviewFeedback } from "@/lib/orchestrator/review-feedback-driver";
import { addRepo } from "@/lib/repos/service";

let db: DB;

beforeEach(() => {
  db = createDb(":memory:");
});

/** A forge stub; review-thread methods present only when `reviewable`. */
function forgeStub(reviewable: boolean): ForgeClient {
  const base = {} as ForgeClient;
  if (reviewable) {
    base.listReviewThreads = vi.fn(async () => [] as ReviewThread[]);
    base.replyToReviewThread = vi.fn(async () => undefined);
    base.updateReviewComment = vi.fn(async () => undefined);
    base.resolveReviewThread = vi.fn(async () => undefined);
    base.reactToReviewComment = vi.fn(async () => undefined);
  }
  return base;
}

/** Create a job that has reached a PR (prNumber + branch set). */
function jobWithPr(repo: Repo, issue: number, pr: number): Job {
  const j = createJob({ repoId: repo.id, issueNumber: issue }, db);
  transitionJob(j.id, "working", {}, db);
  return transitionJob(
    j.id,
    "ci_running",
    { prNumber: pr, branch: `drydock/issue-${issue}-job-${j.id}` },
    db,
  );
}

describe("driveReviewFeedback — selection", () => {
  it("skips repos that have not opted in", async () => {
    const repo = addRepo({ path: "/r", name: "r", autoReviewFeedback: false }, db);
    jobWithPr(repo, 1, 5);
    const processJob = vi.fn(async () => undefined);
    await driveReviewFeedback({ db, forgeFor: () => forgeStub(true), processJob });
    expect(processJob).not.toHaveBeenCalled();
  });

  it("skips repos whose forge has no review-thread support", async () => {
    const repo = addRepo({ path: "/r", name: "r", autoReviewFeedback: true }, db);
    jobWithPr(repo, 1, 5);
    const processJob = vi.fn(async () => undefined);
    await driveReviewFeedback({ db, forgeFor: () => forgeStub(false), processJob });
    expect(processJob).not.toHaveBeenCalled();
  });

  it("processes each opted-in repo's jobs that have an open PR", async () => {
    const repo = addRepo({ path: "/r", name: "r", autoReviewFeedback: true }, db);
    const job = jobWithPr(repo, 1, 5);
    // A job without a PR is ignored.
    createJob({ repoId: repo.id, issueNumber: 2 }, db);
    const processJob = vi.fn<(repo: Repo, job: Job, forge: ForgeClient) => Promise<void>>(
      async () => undefined,
    );
    await driveReviewFeedback({ db, forgeFor: () => forgeStub(true), processJob });
    expect(processJob).toHaveBeenCalledOnce();
    expect(processJob.mock.calls[0]?.[1]).toMatchObject({ id: job.id, prNumber: 5 });
  });

  it("isolates a per-job failure so the sweep continues", async () => {
    const repo = addRepo({ path: "/r", name: "r", autoReviewFeedback: true }, db);
    jobWithPr(repo, 1, 5);
    jobWithPr(repo, 2, 6);
    const processJob = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);
    await expect(
      driveReviewFeedback({ db, forgeFor: () => forgeStub(true), processJob }),
    ).resolves.toBeUndefined();
    expect(processJob).toHaveBeenCalledTimes(2);
  });
});

describe("buildAgentApply", () => {
  const repo = { id: 1, path: "/r", name: "r", defaultBranch: "main" } as Repo;
  const job = { id: 3, branch: "drydock/issue-9-job-3", prNumber: 5 } as Job;
  const thread = {
    id: "T1",
    isResolved: false,
    isOutdated: false,
    path: "src/a.ts",
    line: 4,
    comments: [{ id: "C1", databaseId: 1, author: "alice", body: "rename this" }],
  } satisfies ReviewThread;

  function worktreeStub() {
    const wt = { path: "/wt", branch: job.branch ?? "" };
    return {
      wt,
      prepareForBranch: vi.fn(async () => wt),
      commitAndPush: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };
  }

  it("checks out the PR branch, runs the agent, commits, and reports success", async () => {
    const w = worktreeStub();
    const runSession = vi.fn<
      (job: Job, prompt: string, cwd: string) => Promise<{ exitCode: number }>
    >(async () => ({ exitCode: 0 }));
    const apply = buildAgentApply({ repo, job, worktrees: w, runSession });
    const result = await apply({} as never, thread);
    expect(result.ok).toBe(true);
    expect(w.prepareForBranch).toHaveBeenCalledWith(repo, job.branch, expect.any(String));
    // The agent prompt carries the reviewer's comment.
    expect(runSession.mock.calls[0]?.[1]).toContain("rename this");
    expect(w.commitAndPush).toHaveBeenCalledOnce();
    expect(w.remove).toHaveBeenCalledOnce();
  });

  it("reports failure and still cleans up when the agent exits non-zero", async () => {
    const w = worktreeStub();
    const apply = buildAgentApply({
      repo,
      job,
      worktrees: w,
      runSession: async () => ({ exitCode: 1 }),
    });
    const result = await apply({} as never, thread);
    expect(result.ok).toBe(false);
    expect(w.commitAndPush).not.toHaveBeenCalled();
    expect(w.remove).toHaveBeenCalledOnce();
  });

  it("reports failure when the agent produced no commit", async () => {
    const w = worktreeStub();
    w.commitAndPush.mockRejectedValueOnce(new Error("nothing to commit"));
    const apply = buildAgentApply({
      repo,
      job,
      worktrees: w,
      runSession: async () => ({ exitCode: 0 }),
    });
    const result = await apply({} as never, thread);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/no change/i);
    expect(w.remove).toHaveBeenCalledOnce();
  });
});
