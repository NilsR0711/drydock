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

function fakeWorktrees() {
  const wt: Worktree = { path: "/wt", branch: "drydock/issue-1-job-1" };
  return {
    prepare: vi.fn(async () => wt),
    commitAndPush: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  };
}

function deps(over: Record<string, unknown> = {}) {
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
    notify: vi.fn(async () => {}),
    ...over,
  };
}

function promptOf(d: ReturnType<typeof deps>): string {
  return (d.runSession as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
}

describe("runJob with per-repo agent instructions", () => {
  it("injects the custom instructions into the work prompt when set", async () => {
    const repo = addRepo(
      { path: "/r", name: "r", agentInstructions: "Always run pnpm test before pushing." },
      db,
    );
    syncIssuesFromGh(repo.id, [{ number: 1, title: "Task", labels: [] }], db);

    const d = deps();
    const job = createJob({ repoId: repo.id, issueNumber: 1 }, db);
    await runJob(job.id, d as never);

    const prompt = promptOf(d);
    expect(prompt).toContain("## Repository-specific agent instructions");
    expect(prompt).toContain("Always run pnpm test before pushing.");
  });

  it("leaves the prompt unchanged when no instructions are configured", async () => {
    const repo = addRepo({ path: "/r", name: "r" }, db);
    syncIssuesFromGh(repo.id, [{ number: 1, title: "Task", labels: [] }], db);

    const d = deps();
    const job = createJob({ repoId: repo.id, issueNumber: 1 }, db);
    await runJob(job.id, d as never);

    expect(promptOf(d)).not.toContain("## Repository-specific agent instructions");
  });
});
