import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerAdr } from "@/lib/adr/service";
import { createDb, type DB } from "@/lib/db/client";
import { type Job, jobs } from "@/lib/db/schema";
import { EmptyCommitError, type Worktree } from "@/lib/git/worktree";
import { createJob, getJob, transitionJob } from "@/lib/orchestrator/jobs";
import { runJob } from "@/lib/orchestrator/run-job";
import { TEMPLATE_NAMES } from "@/lib/prompts/defaults";
import { saveTemplate } from "@/lib/prompts/templates";
import { addRepo } from "@/lib/repos/service";

let db: DB;
let repoId: number;
beforeEach(() => {
  db = createDb(":memory:");
  repoId = addRepo({ path: "/repo", name: "acme", defaultModel: "claude-opus-4-7" }, db).id;
});

function fakeWorktrees(removed: { v: boolean }) {
  const wt: Worktree = { path: "/wt", branch: "drydock/issue-1-job-1" };
  return {
    prepare: vi.fn(async () => wt),
    commitAndPush: vi.fn(async () => {}),
    commitAndPushForHuman: vi.fn(async () => false),
    remove: vi.fn(async () => {
      removed.v = true;
    }),
  };
}

function baseDeps(removed: { v: boolean }, over: Record<string, unknown> = {}) {
  return {
    db,
    worktrees: fakeWorktrees(removed),
    runSession: vi.fn(async (job: Job) => {
      db.update(jobs).set({ status: "working", sessionId: "s1" }).where(eq(jobs.id, job.id)).run();
      return { exitCode: 0, sessionId: "s1", costUsd: 0.1, inputTokens: 1, outputTokens: 1 };
    }),
    createPr: vi.fn(async () => 55),
    viewIssue: vi.fn(async () => ({ title: "", body: "" })),
    runBabysitter: vi.fn(async (job: Job) => {
      db.update(jobs).set({ status: "merged" }).where(eq(jobs.id, job.id)).run();
      return getJob(job.id, db) as Job;
    }),
    ...over,
  };
}

describe("runJob", () => {
  it("drives a job to merged and always cleans up the worktree", async () => {
    const removed = { v: false };
    const deps = baseDeps(removed);
    const job = createJob({ repoId, issueNumber: 1 }, db);
    const result = await runJob(job.id, deps as never);
    expect(result.status).toBe("merged");
    expect(result.prNumber).toBe(55);
    expect(deps.worktrees.prepare).toHaveBeenCalled();
    expect(deps.worktrees.commitAndPush).toHaveBeenCalled();
    expect(deps.createPr).toHaveBeenCalledWith(
      expect.objectContaining({ head: "drydock/issue-1-job-1", base: "main" }),
    );
    expect(deps.runBabysitter).toHaveBeenCalled();
    expect(removed.v).toBe(true);
  });

  it("uses the repo's saved main template for the session prompt", async () => {
    saveTemplate(
      { repoId, name: TEMPLATE_NAMES.main, content: "DO ISSUE $ISSUE_NUM ON $BRANCH" },
      db,
    );
    const removed = { v: false };
    const deps = baseDeps(removed);
    const job = createJob({ repoId, issueNumber: 1 }, db);
    await runJob(job.id, deps as never);
    const prompt = (deps.runSession as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(prompt).toContain("DO ISSUE 1 ON ");
  });

  it("notifies on pr_opened and pr_merged for a merged outcome", async () => {
    const removed = { v: false };
    const notify = vi.fn(async () => {});
    const deps = baseDeps(removed, { notify });
    const job = createJob({ repoId, issueNumber: 1 }, db);
    await runJob(job.id, deps as never);
    expect(notify).toHaveBeenCalledWith("pr_opened", expect.stringContaining("PR opened"));
    expect(notify).toHaveBeenCalledWith("pr_merged", expect.stringContaining("Merged"));
  });

  it("blocks the merge and routes to needs_human when ADR gating finds pending ADRs", async () => {
    const gatedRepo = addRepo({ path: "/g", name: "gated", adrGating: true }, db);
    registerAdr({ repoId: gatedRepo.id, filePath: "/g/docs/adr/1.md", content: "# Decide" }, db);
    const removed = { v: false };
    const deps = baseDeps(removed);
    const job = createJob({ repoId: gatedRepo.id, issueNumber: 1 }, db);
    const result = await runJob(job.id, deps as never);
    expect(result.status).toBe("needs_human");
    expect(result.errorMessage).toContain("pending ADR");
    expect(deps.createPr).not.toHaveBeenCalled();
    expect(removed.v).toBe(true);
  });

  it("marks needs_human and cleans up when the session exits non-zero", async () => {
    const removed = { v: false };
    const deps = baseDeps(removed, {
      runSession: vi.fn(async (job: Job) => {
        db.update(jobs).set({ status: "working" }).where(eq(jobs.id, job.id)).run();
        return { exitCode: 1, sessionId: "s1", costUsd: 0, inputTokens: 0, outputTokens: 0 };
      }),
    });
    const job = createJob({ repoId, issueNumber: 1 }, db);
    const result = await runJob(job.id, deps as never);
    expect(result.status).toBe("needs_human");
    expect(deps.createPr).not.toHaveBeenCalled();
    expect(removed.v).toBe(true);
  });

  it("marks needs_human with a timed-out reason when the session hits the wall-clock limit (issue #47)", async () => {
    const removed = { v: false };
    const deps = baseDeps(removed, {
      runSession: vi.fn(async (job: Job) => {
        db.update(jobs).set({ status: "working" }).where(eq(jobs.id, job.id)).run();
        return {
          exitCode: -1,
          sessionId: "s1",
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          timedOut: true,
        };
      }),
    });
    const job = createJob({ repoId, issueNumber: 1 }, db);
    const result = await runJob(job.id, deps as never);
    expect(result.status).toBe("needs_human");
    expect(result.errorMessage).toMatch(/timed out/i);
    expect(deps.createPr).not.toHaveBeenCalled();
    expect(removed.v).toBe(true);
  });

  it("marks needs_human with a cost-limit reason when the session crosses the per-job cap (issue #57)", async () => {
    const removed = { v: false };
    const deps = baseDeps(removed, {
      runSession: vi.fn(async (job: Job) => {
        db.update(jobs).set({ status: "working" }).where(eq(jobs.id, job.id)).run();
        return {
          exitCode: -2,
          sessionId: "s1",
          costUsd: 1.5,
          inputTokens: 0,
          outputTokens: 0,
          timedOut: false,
          costExceeded: true,
        };
      }),
    });
    const job = createJob({ repoId, issueNumber: 1 }, db);
    const result = await runJob(job.id, deps as never);
    expect(result.status).toBe("needs_human");
    expect(result.errorMessage).toMatch(/cost limit/i);
    expect(deps.createPr).not.toHaveBeenCalled();
    expect(removed.v).toBe(true);
  });

  it("reports a clear no-changes reason instead of a raw git error when the agent produced no changes (issue #50)", async () => {
    const removed = { v: false };
    const wt = fakeWorktrees(removed);
    wt.commitAndPush = vi.fn(async () => {
      throw new EmptyCommitError();
    });
    const notify = vi.fn(async () => {});
    const deps = baseDeps(removed, { worktrees: wt, notify });
    const job = createJob({ repoId, issueNumber: 1 }, db);
    const result = await runJob(job.id, deps as never);
    expect(result.status).toBe("needs_human");
    expect(result.errorMessage).toMatch(/no changes/i);
    expect(result.errorMessage).not.toMatch(/nothing to commit/i);
    expect(deps.createPr).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("needs_human", expect.stringContaining("no changes"));
    expect(removed.v).toBe(true);
  });

  it("marks needs_human and cleans up when git push throws", async () => {
    const removed = { v: false };
    const wt = fakeWorktrees(removed);
    wt.commitAndPush = vi.fn(async () => {
      throw new Error("push rejected");
    });
    const deps = baseDeps(removed, { worktrees: wt });
    const job = createJob({ repoId, issueNumber: 1 }, db);
    const result = await runJob(job.id, deps as never);
    expect(result.status).toBe("needs_human");
    expect(result.errorMessage).toContain("push rejected");
    expect(removed.v).toBe(true);
  });

  it("recovers a job to needs_human when a throw lands while it sits in ci_failed", async () => {
    const removed = { v: false };
    const deps = baseDeps(removed, {
      runBabysitter: vi.fn(async (job: Job) => {
        // Simulate a crash between the babysitter's ci_failed and retrying
        // transitions: the job must not strand in non-terminal ci_failed
        // (which would block a sequential repo's pipeline forever).
        transitionJob(job.id, "ci_failed", {}, db);
        throw new Error("resume crashed");
      }),
    });
    const job = createJob({ repoId, issueNumber: 9 }, db);
    const result = await runJob(job.id, deps as never);
    expect(result.status).toBe("needs_human");
    expect(result.errorMessage).toContain("resume crashed");
    expect(removed.v).toBe(true);
  });

  it("returns the settled row when a concurrent abort lands before failure handling", async () => {
    const removed = { v: false };
    const deps = baseDeps(removed, {
      runBabysitter: vi.fn(async (job: Job) => {
        // An operator abort flips the job terminal while the babysitter dies;
        // the catch block must report the settled row, not throw.
        transitionJob(job.id, "aborted", {}, db);
        throw new Error("SIGTERM");
      }),
    });
    const job = createJob({ repoId, issueNumber: 10 }, db);
    const result = await runJob(job.id, deps as never);
    expect(result.status).toBe("aborted");
    expect(removed.v).toBe(true);
  });

  it("parks the job with a descriptive message when the agent CLI fails to spawn", async () => {
    const removed = { v: false };
    const spawnErr = Object.assign(new Error("spawn __noncli__: ENOENT"), { code: "ENOENT" });
    const deps = baseDeps(removed, {
      runSession: vi.fn(async () => ({
        exitCode: 1,
        spawnError: spawnErr,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        timedOut: false,
        costExceeded: false,
      })),
    });
    const job = createJob({ repoId, issueNumber: 8 }, db);
    const result = await runJob(job.id, deps as never);
    expect(result.status).toBe("needs_human");
    expect(result.errorMessage).toMatch(/failed to start/i);
    expect(result.errorMessage).toContain("ENOENT");
    expect(deps.createPr).not.toHaveBeenCalled();
    expect(removed.v).toBe(true);
  });
});
