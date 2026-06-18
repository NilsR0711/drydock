import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { type Job, jobs } from "@/lib/db/schema";
import type { Worktree } from "@/lib/git/worktree";
import { createJob, getJob } from "@/lib/orchestrator/jobs";
import { runJob } from "@/lib/orchestrator/run-job";
import { addRepo } from "@/lib/repos/service";

let db: DB;
beforeEach(() => {
  db = createDb(":memory:");
});

function fakeWorktrees() {
  const wt: Worktree = { path: "/wt/job", branch: "drydock/issue-1-job-1" };
  return {
    prepare: vi.fn(async () => wt),
    commitAndPush: vi.fn(async () => {}),
    commitAndPushForHuman: vi.fn(async () => false),
    remove: vi.fn(async () => {}),
  };
}

function baseDeps(over: Record<string, unknown> = {}) {
  return {
    db,
    worktrees: fakeWorktrees(),
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
    announceNeedsHuman: vi.fn(async () => {}),
    ...over,
  };
}

describe("runJob — sandboxed execution (issue #182)", () => {
  it("escalates to needs_human with a clear reason when the sandbox runtime is unavailable", async () => {
    const repoId = addRepo({ path: "/r", name: "sbx", sandbox: "docker" }, db).id;
    const prepareSandbox = vi.fn(async () => ({
      ok: false as const,
      reason: "No usable container runtime found (tried docker / podman).",
    }));
    const deps = baseDeps({ prepareSandbox });
    const job = createJob({ repoId, issueNumber: 1 }, db);
    const result = await runJob(job.id, deps as never);
    expect(result.status).toBe("needs_human");
    expect(result.errorMessage?.toLowerCase()).toContain("container runtime");
    expect(deps.createPr).not.toHaveBeenCalled();
    expect(deps.worktrees.commitAndPush).not.toHaveBeenCalled();
  });

  it("prepares the sandbox with the job worktree and bare in-container command, then proceeds", async () => {
    const repoId = addRepo({ path: "/r", name: "sbx2", sandbox: "docker" }, db).id;
    const prepareSandbox = vi.fn(async (_input: { jobId: number }) => ({
      ok: true as const,
      session: {
        runner: (() => ({ done: Promise.resolve(0), abort: () => {} })) as never,
        command: "claude",
      },
    }));
    const deps = baseDeps({ prepareSandbox });
    const job = createJob({ repoId, issueNumber: 1 }, db);
    const result = await runJob(job.id, deps as never);
    expect(result.status).toBe("merged");
    expect(prepareSandbox).toHaveBeenCalledTimes(1);
    const arg = prepareSandbox.mock.calls[0]?.[0] as {
      jobId: number;
      worktreePath: string;
      inContainerCommand: string;
      config: { mode: string };
    };
    expect(arg.jobId).toBe(job.id);
    expect(arg.worktreePath).toBe("/wt/job");
    expect(arg.inContainerCommand).toBe("claude");
    expect(arg.config.mode).toBe("docker");
  });

  it("never prepares a sandbox for a repo that has not opted in (no behavior change)", async () => {
    const repoId = addRepo({ path: "/r", name: "plain" }, db).id;
    const prepareSandbox = vi.fn();
    const deps = baseDeps({ prepareSandbox });
    const job = createJob({ repoId, issueNumber: 1 }, db);
    const result = await runJob(job.id, deps as never);
    expect(result.status).toBe("merged");
    expect(prepareSandbox).not.toHaveBeenCalled();
  });
});
