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

function fakeWorktrees() {
  return {
    prepare: vi.fn(async () => WT),
    commitAndPush: vi.fn(async () => {}),
    commitAndPushForHuman: vi.fn(async () => false),
    remove: vi.fn(async () => {}),
  };
}

/**
 * Capture the `bypassPermissions` flag the run-job lifecycle hands to the agent
 * session (issue #283). The implement session is dependency-injected as the 4th
 * positional arg, mirroring how `runReleaseJob` threads it.
 */
function deps(seen: { bypass?: boolean }, over: Record<string, unknown> = {}) {
  return {
    db,
    worktrees: fakeWorktrees(),
    runSession: vi.fn(async (job: Job, _p: string, _c: string, bypassPermissions?: boolean) => {
      seen.bypass = bypassPermissions;
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

describe("runJob --dangerously-skip-permissions wiring (issue #283)", () => {
  it("runs the implement session edits-only when the repo has not opted in", async () => {
    const repo = addRepo({ path: "/r", name: "r" }, db);
    syncIssuesFromGh(repo.id, [{ number: 1, title: "T", labels: [] }], db);
    const seen: { bypass?: boolean } = {};
    const job = createJob({ repoId: repo.id, issueNumber: 1 }, db);

    const result = await runJob(job.id, deps(seen) as never);

    expect(result.status).toBe("merged");
    expect(seen.bypass).toBe(false);
  });

  it("runs the implement session with full shell access when the repo opts in", async () => {
    const repo = addRepo({ path: "/r", name: "r", bypassPermissions: true }, db);
    syncIssuesFromGh(repo.id, [{ number: 1, title: "T", labels: [] }], db);
    const seen: { bypass?: boolean } = {};
    const job = createJob({ repoId: repo.id, issueNumber: 1 }, db);

    const result = await runJob(job.id, deps(seen) as never);

    expect(result.status).toBe("merged");
    expect(seen.bypass).toBe(true);
  });
});
