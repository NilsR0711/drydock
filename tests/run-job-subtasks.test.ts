import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { type Job, jobs } from "@/lib/db/schema";
import type { Worktree } from "@/lib/git/worktree";
import { syncIssuesFromGh } from "@/lib/issues/service";
import { listSubtasks, replaceSubtasks } from "@/lib/issues/subtasks";
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
    runBabysitter: vi.fn(async (job: Job) => {
      db.update(jobs).set({ status: "merged" }).where(eq(jobs.id, job.id)).run();
      return getJob(job.id, db) as Job;
    }),
    notify: vi.fn(async () => {}),
    ...over,
  };
}

describe("runJob with decomposed subtasks", () => {
  it("injects the subtask checklist into the prompt and marks them done on merge", async () => {
    const repo = addRepo({ path: "/r", name: "r", autoDecompose: true }, db);
    syncIssuesFromGh(repo.id, [{ number: 1, title: "Big", labels: [] }], db);
    replaceSubtasks(repo.id, 1, ["Add API", "Wire UI"], "h", db);

    const d = deps();
    const job = createJob({ repoId: repo.id, issueNumber: 1 }, db);
    const result = await runJob(job.id, d as never);

    expect(result.status).toBe("merged");
    const prompt = (d.runSession as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(prompt).toContain("## Subtasks");
    expect(prompt).toContain("1. [ ] Add API");
    expect(prompt).toContain("2. [ ] Wire UI");
    expect(listSubtasks(repo.id, 1, db).every((s) => s.status === "done")).toBe(true);
  });

  it("does not touch the prompt or subtasks when the repo has not opted in", async () => {
    const repo = addRepo({ path: "/r", name: "r", autoDecompose: false }, db);
    syncIssuesFromGh(repo.id, [{ number: 1, title: "Big", labels: [] }], db);
    replaceSubtasks(repo.id, 1, ["Add API", "Wire UI"], "h", db);

    const d = deps();
    const job = createJob({ repoId: repo.id, issueNumber: 1 }, db);
    await runJob(job.id, d as never);

    const prompt = (d.runSession as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(prompt).not.toContain("## Subtasks");
    expect(listSubtasks(repo.id, 1, db).every((s) => s.status === "pending")).toBe(true);
  });

  it("leaves subtasks in progress when the job does not merge", async () => {
    const repo = addRepo({ path: "/r", name: "r", autoDecompose: true }, db);
    syncIssuesFromGh(repo.id, [{ number: 1, title: "Big", labels: [] }], db);
    replaceSubtasks(repo.id, 1, ["Add API", "Wire UI"], "h", db);

    const d = deps({
      runBabysitter: vi.fn(async (job: Job) => {
        db.update(jobs).set({ status: "needs_human" }).where(eq(jobs.id, job.id)).run();
        return getJob(job.id, db) as Job;
      }),
    });
    const job = createJob({ repoId: repo.id, issueNumber: 1 }, db);
    const result = await runJob(job.id, d as never);

    expect(result.status).toBe("needs_human");
    expect(listSubtasks(repo.id, 1, db).every((s) => s.status === "in_progress")).toBe(true);
  });
});
