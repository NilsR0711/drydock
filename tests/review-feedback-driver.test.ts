import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import type { Job, Repo } from "@/lib/db/schema";
import type { ForgeClient, ReviewThread } from "@/lib/forge/types";
import { createJob, transitionJob } from "@/lib/orchestrator/jobs";
import { latchProviderLimit } from "@/lib/orchestrator/provider-limit";
import {
  __pendingReviewSweepCount,
  __setReviewSweepRunner,
  buildAgentApply,
  driveReviewFeedback,
  REVIEW_SWEEP_DEBOUNCE_MS,
  runReviewFeedbackSweep,
  triggerReviewFeedbackSweep,
} from "@/lib/orchestrator/review-feedback-driver";
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

  it("skips jobs whose agent is limit-latched so side sessions never bounce (issue #167)", async () => {
    const repo = addRepo({ path: "/r", name: "r", autoReviewFeedback: true }, db);
    const codexJob = createJob({ repoId: repo.id, issueNumber: 1, agent: "codex" }, db);
    transitionJob(codexJob.id, "working", {}, db);
    transitionJob(codexJob.id, "ci_running", { prNumber: 5, branch: "b1" }, db);
    const claudeJob = jobWithPr(repo, 2, 6);
    latchProviderLimit(
      {
        agent: "codex",
        kind: "usage_limit",
        rawSnippet: "limit",
        resetAt: Math.floor(Date.now() / 1000) + 3600,
      },
      db,
    );
    const processJob = vi.fn<(repo: Repo, job: Job) => Promise<void>>(async () => undefined);
    await driveReviewFeedback({ db, forgeFor: () => forgeStub(true), processJob });
    expect(processJob).toHaveBeenCalledOnce();
    expect(processJob.mock.calls[0]?.[1]).toMatchObject({ id: claudeJob.id });
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

  it("limits the sweep to one repo when repoId is given (issue #180)", async () => {
    const r1 = addRepo({ path: "/r1", name: "r1", autoReviewFeedback: true }, db);
    const r2 = addRepo({ path: "/r2", name: "r2", autoReviewFeedback: true }, db);
    jobWithPr(r1, 1, 5);
    jobWithPr(r2, 2, 6);
    const processJob = vi.fn<(repo: Repo, job: Job, forge: ForgeClient) => Promise<void>>(
      async () => undefined,
    );
    await driveReviewFeedback({ db, repoId: r2.id, forgeFor: () => forgeStub(true), processJob });
    expect(processJob).toHaveBeenCalledOnce();
    expect(processJob.mock.calls[0]?.[0]).toMatchObject({ id: r2.id });
  });
});

describe("runReviewFeedbackSweep — serialization (issue #180)", () => {
  it("never overlaps two sweeps", async () => {
    const repo = addRepo({ path: "/r", name: "r", autoReviewFeedback: true }, db);
    jobWithPr(repo, 1, 5);
    let active = 0;
    let maxActive = 0;
    const processJob = vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    });
    const deps = { db, forgeFor: () => forgeStub(true), processJob };
    await Promise.all([runReviewFeedbackSweep(deps), runReviewFeedbackSweep(deps)]);
    expect(processJob).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
  });

  it("keeps the chain alive after a sweep rejects", async () => {
    // A broken DB makes the sweep itself reject (listRepos throws); the
    // rejection must reach this caller without poisoning the shared chain.
    await expect(runReviewFeedbackSweep({ db: {} as DB })).rejects.toThrow();
    const repo = addRepo({ path: "/r", name: "r", autoReviewFeedback: true }, db);
    jobWithPr(repo, 1, 5);
    const processJob = vi.fn(async () => undefined);
    await runReviewFeedbackSweep({ db, forgeFor: () => forgeStub(true), processJob });
    expect(processJob).toHaveBeenCalledOnce();
  });
});

describe("triggerReviewFeedbackSweep (issue #180)", () => {
  let runner: Mock<(repoId: number) => Promise<void>>;
  beforeEach(() => {
    vi.useFakeTimers();
    runner = vi.fn(async () => {});
    __setReviewSweepRunner(runner);
  });
  afterEach(() => {
    __setReviewSweepRunner(null);
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("coalesces a burst of triggers for one repo into a single sweep", async () => {
    triggerReviewFeedbackSweep(1);
    triggerReviewFeedbackSweep(1);
    triggerReviewFeedbackSweep(1);
    expect(__pendingReviewSweepCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(REVIEW_SWEEP_DEBOUNCE_MS);
    expect(runner).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledWith(1);
    expect(__pendingReviewSweepCount()).toBe(0);
  });

  it("keeps distinct repos independent", async () => {
    triggerReviewFeedbackSweep(1);
    triggerReviewFeedbackSweep(2);
    expect(__pendingReviewSweepCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(REVIEW_SWEEP_DEBOUNCE_MS);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner).toHaveBeenCalledWith(1);
    expect(runner).toHaveBeenCalledWith(2);
  });

  it("isolates and logs a failing sweep instead of throwing", async () => {
    runner.mockRejectedValueOnce(new Error("boom"));
    triggerReviewFeedbackSweep(1);
    await vi.advanceTimersByTimeAsync(REVIEW_SWEEP_DEBOUNCE_MS);
    expect(runner).toHaveBeenCalledOnce();
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
