import { type DB, createDb } from "@/lib/db/client";
import { type Job, jobs } from "@/lib/db/schema";
import type { Worktree } from "@/lib/git/worktree";
import { createJob, getJob } from "@/lib/orchestrator/jobs";
import { runJob } from "@/lib/orchestrator/run-job";
import { TEMPLATE_NAMES } from "@/lib/prompts/defaults";
import { saveTemplate } from "@/lib/prompts/templates";
import { addRepo } from "@/lib/repos/service";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
});
