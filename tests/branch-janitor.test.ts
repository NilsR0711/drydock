import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { type Job, jobEvents, type Repo } from "@/lib/db/schema";
import type { ForgeClient, PrMergeState } from "@/lib/forge/types";
import { conflictCommentMarker, runBranchJanitorSweep } from "@/lib/orchestrator/branch-janitor";
import { createJob, getJob, transitionJob } from "@/lib/orchestrator/jobs";
import { addRepo } from "@/lib/repos/service";

let db: DB;
beforeEach(() => {
  db = createDb(":memory:");
});

function makeRepo(over: Record<string, unknown> = {}): Repo {
  return addRepo({ path: "/r", name: "r", defaultBranch: "main", ...over }, db);
}

/** A merged job that went through a PR on `branch`. */
function mergedJob(repo: Repo, issue: number, pr: number, branch: string): Job {
  const j = createJob({ repoId: repo.id, issueNumber: issue }, db);
  transitionJob(j.id, "working", {}, db);
  transitionJob(j.id, "ci_running", { prNumber: pr, branch }, db);
  return transitionJob(j.id, "merged", {}, db);
}

/** A job with an open PR currently being babysat. */
function openPrJob(repo: Repo, issue: number, pr: number, branch: string): Job {
  const j = createJob({ repoId: repo.id, issueNumber: issue }, db);
  transitionJob(j.id, "working", {}, db);
  return transitionJob(j.id, "ci_running", { prNumber: pr, branch }, db);
}

/**
 * A rebase stub that never clears the conflict, so the sweep falls through to
 * the park path. Lets the escalation tests exercise the flag-on default
 * (rebase attempted, fails) without touching real git.
 */
const failRebase = async (): Promise<{ ok: boolean }> => ({ ok: false });

function janitorForge(over: Partial<ForgeClient> = {}): ForgeClient {
  return {
    deleteBranch: vi.fn(async () => {}),
    prMergeState: vi.fn(async (): Promise<PrMergeState> => "clean"),
    updatePrBranch: vi.fn(async () => {}),
    commentIssue: vi.fn(async () => {}),
    ensureLabel: vi.fn(async () => {}),
    addLabels: vi.fn(async () => {}),
    removeLabels: vi.fn(async () => {}),
    ...over,
  } as unknown as ForgeClient;
}

describe("runBranchJanitorSweep — merged-branch cleanup", () => {
  it("deletes the remote drydock/* branch of a merged PR job", async () => {
    const repo = makeRepo();
    mergedJob(repo, 7, 12, "drydock/issue-7-job-1");
    const forge = janitorForge();
    await runBranchJanitorSweep({ db, forgeFor: () => forge });
    expect(forge.deleteBranch).toHaveBeenCalledTimes(1);
    expect(forge.deleteBranch).toHaveBeenCalledWith("drydock/issue-7-job-1");
  });

  it("is idempotent across sweeps (one delete total)", async () => {
    const repo = makeRepo();
    mergedJob(repo, 7, 12, "drydock/issue-7-job-1");
    const forge = janitorForge();
    await runBranchJanitorSweep({ db, forgeFor: () => forge });
    await runBranchJanitorSweep({ db, forgeFor: () => forge });
    expect(forge.deleteBranch).toHaveBeenCalledTimes(1);
  });

  it("stamps a janitor event so the cleanup survives a restart", async () => {
    const repo = makeRepo();
    const job = mergedJob(repo, 7, 12, "drydock/issue-7-job-1");
    await runBranchJanitorSweep({ db, forgeFor: () => janitorForge() });
    const events = db.select().from(jobEvents).where(eq(jobEvents.jobId, job.id)).all();
    const janitor = events.filter((e) => e.type === "janitor");
    expect(janitor).toHaveLength(1);
    expect(JSON.parse(janitor[0]?.payload ?? "{}")).toMatchObject({
      action: "branch_deleted",
      branch: "drydock/issue-7-job-1",
    });
  });

  it("never deletes a branch without the drydock/ prefix", async () => {
    const repo = makeRepo();
    mergedJob(repo, 7, 12, "feature/manual-work");
    const forge = janitorForge();
    await runBranchJanitorSweep({ db, forgeFor: () => forge });
    expect(forge.deleteBranch).not.toHaveBeenCalled();
  });

  it("does not delete the branch of a still-open PR job", async () => {
    const repo = makeRepo();
    openPrJob(repo, 7, 12, "drydock/issue-7-job-1");
    const forge = janitorForge();
    await runBranchJanitorSweep({ db, forgeFor: () => forge });
    expect(forge.deleteBranch).not.toHaveBeenCalled();
  });

  it("keeps a branch that another live job still references", async () => {
    const repo = makeRepo();
    mergedJob(repo, 7, 12, "drydock/shared");
    openPrJob(repo, 8, 13, "drydock/shared");
    const forge = janitorForge();
    await runBranchJanitorSweep({ db, forgeFor: () => forge });
    expect(forge.deleteBranch).not.toHaveBeenCalled();
  });

  it("retries a failed delete on the next sweep (no stamp on failure)", async () => {
    const repo = makeRepo();
    mergedJob(repo, 7, 12, "drydock/issue-7-job-1");
    const deleteBranch = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);
    const forge = janitorForge({ deleteBranch });
    await runBranchJanitorSweep({ db, forgeFor: () => forge });
    await runBranchJanitorSweep({ db, forgeFor: () => forge });
    expect(deleteBranch).toHaveBeenCalledTimes(2);
  });

  it("skips cleanup when the forge cannot delete branches", async () => {
    const repo = makeRepo();
    mergedJob(repo, 7, 12, "drydock/issue-7-job-1");
    const forge = janitorForge({ deleteBranch: undefined });
    await expect(runBranchJanitorSweep({ db, forgeFor: () => forge })).resolves.toBeUndefined();
  });
});

describe("runBranchJanitorSweep — stale/conflicted PR refresh", () => {
  it("updates the branch of a behind, conflict-free PR", async () => {
    const repo = makeRepo();
    openPrJob(repo, 7, 12, "drydock/issue-7-job-1");
    const forge = janitorForge({
      prMergeState: vi.fn(async (): Promise<PrMergeState> => "behind"),
    });
    await runBranchJanitorSweep({ db, forgeFor: () => forge });
    expect(forge.updatePrBranch).toHaveBeenCalledTimes(1);
    expect(forge.updatePrBranch).toHaveBeenCalledWith(12);
  });

  it("escalates a conflicted PR to needs_human when auto-rebase cannot clear it", async () => {
    const repo = makeRepo();
    const job = openPrJob(repo, 7, 12, "drydock/issue-7-job-1");
    const forge = janitorForge({
      prMergeState: vi.fn(async (): Promise<PrMergeState> => "conflicted"),
    });
    await runBranchJanitorSweep({ db, forgeFor: () => forge, rebaseBranch: failRebase });
    const fresh = getJob(job.id, db);
    expect(fresh?.status).toBe("needs_human");
    expect(fresh?.errorMessage).toBe("rebase needed: conflicts with main");
    expect(forge.updatePrBranch).not.toHaveBeenCalled();
  });

  it("names the repo's actual default branch in the escalation reason", async () => {
    const repo = makeRepo({ defaultBranch: "develop" });
    const job = openPrJob(repo, 7, 12, "drydock/issue-7-job-1");
    const forge = janitorForge({
      prMergeState: vi.fn(async (): Promise<PrMergeState> => "conflicted"),
    });
    await runBranchJanitorSweep({ db, forgeFor: () => forge, rebaseBranch: failRebase });
    expect(getJob(job.id, db)?.errorMessage).toBe("rebase needed: conflicts with develop");
  });

  it("comments on the issue when escalating a conflicted PR", async () => {
    const repo = makeRepo();
    openPrJob(repo, 7, 12, "drydock/issue-7-job-1");
    const forge = janitorForge({
      prMergeState: vi.fn(async (): Promise<PrMergeState> => "conflicted"),
    });
    await runBranchJanitorSweep({ db, forgeFor: () => forge, rebaseBranch: failRebase });
    expect(forge.commentIssue).toHaveBeenCalledOnce();
    const [issueNumber, body] = (forge.commentIssue as ReturnType<typeof vi.fn>).mock.calls[0] as [
      number,
      string,
    ];
    expect(issueNumber).toBe(7);
    expect(body).toContain("#12");
    expect(body).toContain("main");
  });

  it("embeds the conflict marker so a re-escalation edits in place", async () => {
    const repo = makeRepo();
    const job = openPrJob(repo, 7, 12, "drydock/issue-7-job-1");
    const forge = janitorForge({
      prMergeState: vi.fn(async (): Promise<PrMergeState> => "conflicted"),
    });
    await runBranchJanitorSweep({ db, forgeFor: () => forge });
    const body = (forge.commentIssue as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(body).toContain(conflictCommentMarker(job.id));
  });

  it("still escalates when the issue comment fails (best-effort)", async () => {
    const repo = makeRepo();
    const job = openPrJob(repo, 7, 12, "drydock/issue-7-job-1");
    const forge = janitorForge({
      prMergeState: vi.fn(async (): Promise<PrMergeState> => "conflicted"),
      commentIssue: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    await runBranchJanitorSweep({ db, forgeFor: () => forge, rebaseBranch: failRebase });
    expect(getJob(job.id, db)?.status).toBe("needs_human");
  });

  it("sets the needs-human label and drops the queue label on a conflicted PR (issue #250)", async () => {
    const repo = makeRepo();
    openPrJob(repo, 7, 12, "drydock/issue-7-job-1");
    const forge = janitorForge({
      prMergeState: vi.fn(async (): Promise<PrMergeState> => "conflicted"),
    });
    await runBranchJanitorSweep({ db, forgeFor: () => forge, rebaseBranch: failRebase });
    expect(forge.addLabels).toHaveBeenCalledWith(7, ["drydock:needs-human"]);
    expect(forge.removeLabels).toHaveBeenCalledWith(7, ["drydock:queue"]);
  });

  it("leaves a clean PR untouched", async () => {
    const repo = makeRepo();
    const job = openPrJob(repo, 7, 12, "drydock/issue-7-job-1");
    const forge = janitorForge();
    await runBranchJanitorSweep({ db, forgeFor: () => forge });
    expect(forge.updatePrBranch).not.toHaveBeenCalled();
    expect(getJob(job.id, db)?.status).toBe("ci_running");
  });

  it("re-probes an unknown merge state later instead of acting", async () => {
    const repo = makeRepo();
    const job = openPrJob(repo, 7, 12, "drydock/issue-7-job-1");
    const forge = janitorForge({
      prMergeState: vi.fn(async (): Promise<PrMergeState> => "unknown"),
    });
    await runBranchJanitorSweep({ db, forgeFor: () => forge });
    expect(forge.updatePrBranch).not.toHaveBeenCalled();
    expect(getJob(job.id, db)?.status).toBe("ci_running");
  });

  it("never probes or updates a PR on a non-drydock branch", async () => {
    const repo = makeRepo();
    openPrJob(repo, 7, 12, "feature/manual-work");
    const forge = janitorForge({
      prMergeState: vi.fn(async (): Promise<PrMergeState> => "behind"),
    });
    await runBranchJanitorSweep({ db, forgeFor: () => forge });
    expect(forge.prMergeState).not.toHaveBeenCalled();
    expect(forge.updatePrBranch).not.toHaveBeenCalled();
  });

  it("skips the refresh when the forge cannot probe merge state", async () => {
    const repo = makeRepo();
    const job = openPrJob(repo, 7, 12, "drydock/issue-7-job-1");
    const forge = janitorForge({ prMergeState: undefined });
    await runBranchJanitorSweep({ db, forgeFor: () => forge });
    expect(forge.updatePrBranch).not.toHaveBeenCalled();
    expect(getJob(job.id, db)?.status).toBe("ci_running");
  });

  it("skips a behind PR when the forge cannot update branches", async () => {
    const repo = makeRepo();
    const job = openPrJob(repo, 7, 12, "drydock/issue-7-job-1");
    const forge = janitorForge({
      prMergeState: vi.fn(async (): Promise<PrMergeState> => "behind"),
      updatePrBranch: undefined,
    });
    await runBranchJanitorSweep({ db, forgeFor: () => forge });
    expect(getJob(job.id, db)?.status).toBe("ci_running");
  });

  it("swallows an escalation race when the job settled concurrently", async () => {
    // Flag off so the single merge-state probe drives straight to the park path,
    // isolating the race mechanic from the auto-rebase branch.
    const repo = makeRepo({ autoResolveMergeConflicts: false });
    const job = openPrJob(repo, 7, 12, "drydock/issue-7-job-1");
    const forge = janitorForge({
      prMergeState: vi.fn(async (): Promise<PrMergeState> => {
        // The babysitter merges the job between candidate listing and probe.
        transitionJob(job.id, "merged", {}, db);
        return "conflicted";
      }),
    });
    await expect(runBranchJanitorSweep({ db, forgeFor: () => forge })).resolves.toBeUndefined();
    expect(getJob(job.id, db)?.status).toBe("merged");
  });
});

describe("runBranchJanitorSweep — auto-resolve merge conflicts (issue #287)", () => {
  it("rebases a conflicted PR instead of parking when the repair clears it", async () => {
    const repo = makeRepo(); // autoResolveMergeConflicts defaults on
    const job = openPrJob(repo, 7, 12, "drydock/issue-7-job-1");
    // Conflicted on the initial probes, clean once the rebase has been pushed.
    const prMergeState = vi
      .fn<() => Promise<PrMergeState>>()
      .mockResolvedValueOnce("conflicted")
      .mockResolvedValueOnce("conflicted")
      .mockResolvedValue("clean");
    const forge = janitorForge({ prMergeState });
    const rebaseBranch = vi.fn(async () => ({ ok: true }));

    await runBranchJanitorSweep({ db, forgeFor: () => forge, rebaseBranch });

    expect(rebaseBranch).toHaveBeenCalledWith(
      expect.objectContaining({ id: repo.id }),
      "drydock/issue-7-job-1",
      12,
    );
    // The job is left in place for the merge gate; it is not parked.
    expect(getJob(job.id, db)?.status).toBe("ci_running");
    expect(forge.commentIssue).not.toHaveBeenCalled();
    expect(forge.addLabels).not.toHaveBeenCalled();
    // A janitor event records the successful rebase for the timeline + idempotency.
    const events = db.select().from(jobEvents).where(eq(jobEvents.jobId, job.id)).all();
    const rebased = events
      .filter((e) => e.type === "janitor")
      .map((e) => JSON.parse(e.payload ?? "{}"))
      .find((p) => p.action === "rebased");
    expect(rebased).toMatchObject({ action: "rebased", prNumber: 12 });
  });

  it("parks the PR when the bounded rebase repair cannot clear the conflict", async () => {
    const repo = makeRepo();
    const job = openPrJob(repo, 7, 12, "drydock/issue-7-job-1");
    const forge = janitorForge({
      prMergeState: vi.fn(async (): Promise<PrMergeState> => "conflicted"),
    });
    const rebaseBranch = vi.fn(async () => ({ ok: false }));

    await runBranchJanitorSweep({ db, forgeFor: () => forge, rebaseBranch });

    expect(rebaseBranch).toHaveBeenCalledTimes(1);
    expect(getJob(job.id, db)?.status).toBe("needs_human");
    expect(getJob(job.id, db)?.errorMessage).toBe("rebase needed: conflicts with main");
  });

  it("parks immediately without attempting a rebase when the flag is off", async () => {
    const repo = makeRepo({ autoResolveMergeConflicts: false });
    const job = openPrJob(repo, 7, 12, "drydock/issue-7-job-1");
    const forge = janitorForge({
      prMergeState: vi.fn(async (): Promise<PrMergeState> => "conflicted"),
    });
    const rebaseBranch = vi.fn(async () => ({ ok: true }));

    await runBranchJanitorSweep({ db, forgeFor: () => forge, rebaseBranch });

    expect(rebaseBranch).not.toHaveBeenCalled();
    expect(getJob(job.id, db)?.status).toBe("needs_human");
  });

  it("parks when the rebase attempt throws (safe default)", async () => {
    const repo = makeRepo();
    const job = openPrJob(repo, 7, 12, "drydock/issue-7-job-1");
    const forge = janitorForge({
      prMergeState: vi.fn(async (): Promise<PrMergeState> => "conflicted"),
    });
    const rebaseBranch = vi.fn(async () => {
      throw new Error("git exploded");
    });

    await runBranchJanitorSweep({ db, forgeFor: () => forge, rebaseBranch });

    expect(getJob(job.id, db)?.status).toBe("needs_human");
  });
});

describe("runBranchJanitorSweep — agent conflict resolution (issue #327)", () => {
  /** A janitor event of a given action recorded on a job, if any. */
  function janitorAction(jobId: number, action: string): Record<string, unknown> | undefined {
    return db
      .select()
      .from(jobEvents)
      .where(eq(jobEvents.jobId, jobId))
      .all()
      .filter((e) => e.type === "janitor")
      .map((e) => JSON.parse(e.payload ?? "{}") as Record<string, unknown>)
      .find((p) => p.action === action);
  }

  it("resolves a genuine conflict with an agent instead of parking when opted in", async () => {
    const repo = makeRepo({ resolveConflictsWithAgent: true });
    const job = openPrJob(repo, 7, 12, "drydock/issue-7-job-1");
    const forge = janitorForge({
      prMergeState: vi.fn(async (): Promise<PrMergeState> => "conflicted"),
    });
    const agentResolveBranch = vi.fn(async () => ({ ok: true, resolvedConflicts: 2 }));

    await runBranchJanitorSweep({
      db,
      forgeFor: () => forge,
      rebaseBranch: failRebase, // the plain rebase cannot clear a genuine conflict
      agentResolveBranch,
    });

    expect(agentResolveBranch).toHaveBeenCalledWith(
      expect.objectContaining({ id: repo.id }),
      expect.objectContaining({ id: job.id }),
      12,
    );
    // The PR is left in place for the merge gate — not parked.
    expect(getJob(job.id, db)?.status).toBe("ci_running");
    // The resolution is stamped for the timeline + idempotency.
    expect(janitorAction(job.id, "agent_resolved")).toMatchObject({
      prNumber: 12,
      resolvedConflicts: 2,
    });
  });

  it("posts an auditable comment on the PR describing the agent resolution (issue #327)", async () => {
    const repo = makeRepo({ resolveConflictsWithAgent: true });
    openPrJob(repo, 7, 12, "drydock/issue-7-job-1");
    const forge = janitorForge({
      prMergeState: vi.fn(async (): Promise<PrMergeState> => "conflicted"),
    });
    const agentResolveBranch = vi.fn(async () => ({ ok: true, resolvedConflicts: 1 }));

    await runBranchJanitorSweep({
      db,
      forgeFor: () => forge,
      rebaseBranch: failRebase,
      agentResolveBranch,
    });

    // The audit comment lands on the PR itself (number 12), not the issue (7).
    expect(forge.commentIssue).toHaveBeenCalledOnce();
    const [target, body] = (forge.commentIssue as ReturnType<typeof vi.fn>).mock.calls[0] as [
      number,
      string,
    ];
    expect(target).toBe(12);
    expect(body).toContain("automatically resolved");
  });

  it("attempts agent resolution even when autoResolveMergeConflicts is off (independent flag)", async () => {
    const repo = makeRepo({ autoResolveMergeConflicts: false, resolveConflictsWithAgent: true });
    const job = openPrJob(repo, 7, 12, "drydock/issue-7-job-1");
    const forge = janitorForge({
      prMergeState: vi.fn(async (): Promise<PrMergeState> => "conflicted"),
    });
    const rebaseBranch = vi.fn(async () => ({ ok: true }));
    const agentResolveBranch = vi.fn(async () => ({ ok: true, resolvedConflicts: 1 }));

    await runBranchJanitorSweep({ db, forgeFor: () => forge, rebaseBranch, agentResolveBranch });

    // The plain rebase is skipped (its flag is off); the agent path still runs.
    expect(rebaseBranch).not.toHaveBeenCalled();
    expect(agentResolveBranch).toHaveBeenCalledOnce();
    expect(getJob(job.id, db)?.status).toBe("ci_running");
  });

  it("does not attempt agent resolution when the plain rebase already cleared it", async () => {
    const repo = makeRepo({ resolveConflictsWithAgent: true });
    openPrJob(repo, 7, 12, "drydock/issue-7-job-1");
    // Conflicted on the refresh probe and the repair's first hasConflicts check,
    // clean once the rebase pushed — so the plain rebase clears it (issue #287).
    const prMergeState = vi
      .fn<() => Promise<PrMergeState>>()
      .mockResolvedValueOnce("conflicted")
      .mockResolvedValueOnce("conflicted")
      .mockResolvedValue("clean");
    const forge = janitorForge({ prMergeState });
    const rebaseBranch = vi.fn(async () => ({ ok: true }));
    const agentResolveBranch = vi.fn(async () => ({ ok: true, resolvedConflicts: 1 }));

    await runBranchJanitorSweep({ db, forgeFor: () => forge, rebaseBranch, agentResolveBranch });

    expect(rebaseBranch).toHaveBeenCalledOnce();
    expect(agentResolveBranch).not.toHaveBeenCalled();
  });

  it("never attempts agent resolution when the flag is off (default)", async () => {
    const repo = makeRepo(); // resolveConflictsWithAgent defaults off
    const job = openPrJob(repo, 7, 12, "drydock/issue-7-job-1");
    const forge = janitorForge({
      prMergeState: vi.fn(async (): Promise<PrMergeState> => "conflicted"),
    });
    const agentResolveBranch = vi.fn(async () => ({ ok: true, resolvedConflicts: 1 }));

    await runBranchJanitorSweep({
      db,
      forgeFor: () => forge,
      rebaseBranch: failRebase,
      agentResolveBranch,
    });

    expect(agentResolveBranch).not.toHaveBeenCalled();
    expect(getJob(job.id, db)?.status).toBe("needs_human");
  });

  it("parks for a human when the agent cannot resolve the conflict", async () => {
    const repo = makeRepo({ resolveConflictsWithAgent: true });
    const job = openPrJob(repo, 7, 12, "drydock/issue-7-job-1");
    const forge = janitorForge({
      prMergeState: vi.fn(async (): Promise<PrMergeState> => "conflicted"),
    });
    const agentResolveBranch = vi.fn(async () => ({ ok: false, resolvedConflicts: 0 }));

    await runBranchJanitorSweep({
      db,
      forgeFor: () => forge,
      rebaseBranch: failRebase,
      agentResolveBranch,
    });

    expect(agentResolveBranch).toHaveBeenCalledOnce();
    expect(getJob(job.id, db)?.status).toBe("needs_human");
    expect(getJob(job.id, db)?.errorMessage).toBe("rebase needed: conflicts with main");
  });

  it("parks for a human when the agent resolution throws (safe default)", async () => {
    const repo = makeRepo({ resolveConflictsWithAgent: true });
    const job = openPrJob(repo, 7, 12, "drydock/issue-7-job-1");
    const forge = janitorForge({
      prMergeState: vi.fn(async (): Promise<PrMergeState> => "conflicted"),
    });
    const agentResolveBranch = vi.fn(async () => {
      throw new Error("agent exploded");
    });

    await runBranchJanitorSweep({
      db,
      forgeFor: () => forge,
      rebaseBranch: failRebase,
      agentResolveBranch,
    });

    expect(getJob(job.id, db)?.status).toBe("needs_human");
  });
});

describe("runBranchJanitorSweep — isolation", () => {
  it("a failing repo does not stop the sweep for other repos", async () => {
    const a = addRepo({ path: "/a", name: "a" }, db);
    const b = addRepo({ path: "/b", name: "b" }, db);
    mergedJob(a, 1, 10, "drydock/issue-1-job-1");
    mergedJob(b, 2, 11, "drydock/issue-2-job-2");
    const bForge = janitorForge();
    const forgeFor = (repo: Repo): ForgeClient => {
      if (repo.id === a.id) throw new Error("forge construction failed");
      return bForge;
    };
    await runBranchJanitorSweep({ db, forgeFor });
    expect(bForge.deleteBranch).toHaveBeenCalledTimes(1);
    expect(bForge.deleteBranch).toHaveBeenCalledWith("drydock/issue-2-job-2");
  });

  it("a failing merge-state probe does not stop the merged-branch cleanup", async () => {
    const repo = makeRepo();
    mergedJob(repo, 7, 12, "drydock/issue-7-job-1");
    openPrJob(repo, 8, 13, "drydock/issue-8-job-2");
    const forge = janitorForge({
      prMergeState: vi.fn(async () => {
        throw new Error("api down");
      }),
    });
    await runBranchJanitorSweep({ db, forgeFor: () => forge });
    expect(forge.deleteBranch).toHaveBeenCalledTimes(1);
    expect(forge.deleteBranch).toHaveBeenCalledWith("drydock/issue-7-job-1");
  });
});
