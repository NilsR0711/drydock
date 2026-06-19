import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import type { Repo } from "@/lib/db/schema";
import { issues, type Job, jobs } from "@/lib/db/schema";
import type { Worktree } from "@/lib/git/worktree";
import { createJob, getJob } from "@/lib/orchestrator/jobs";
import { runJob } from "@/lib/orchestrator/run-job";
import { addRepo } from "@/lib/repos/service";

let db: DB;
let repoId: number;
beforeEach(() => {
  db = createDb(":memory:");
  repoId = addRepo({ verifyPr: false, autoPrAudit: false, path: "/repo", name: "acme" }, db).id;
});

function seedIssue(number: number, title: string) {
  db.insert(issues).values({ repoId, number, title }).run();
}

/** Worktree double whose prepare records the label it was handed. */
function capturingWorktrees() {
  const wt: Worktree = { path: "/wt", branch: "drydock/issue-1-job-1" };
  const prepare = vi.fn(
    async (_repo: Repo, _jobId: number, _issueNumber?: number, _label?: string) => wt,
  );
  return {
    prepare,
    commitAndPush: vi.fn(async () => {}),
    commitAndPushForHuman: vi.fn(async () => false),
    remove: vi.fn(async () => {}),
  };
}

function deps(worktrees: ReturnType<typeof capturingWorktrees>) {
  return {
    db,
    worktrees,
    runSession: vi.fn(async (job: Job) => {
      db.update(jobs).set({ status: "working", sessionId: "s1" }).where(eq(jobs.id, job.id)).run();
      return { exitCode: 0, sessionId: "s1", costUsd: 0.1, inputTokens: 1, outputTokens: 1 };
    }),
    createPr: vi.fn(async () => 55),
    runBabysitter: vi.fn(async (job: Job) => {
      db.update(jobs).set({ status: "merged" }).where(eq(jobs.id, job.id)).run();
      return getJob(job.id, db) as Job;
    }),
    viewIssue: vi.fn(async () => ({ title: "ignored at branch time", body: "" })),
  };
}

describe("runJob — human-readable branch names (issue #278)", () => {
  it("passes a slugified issue-title label to prepare when the cache has the title", async () => {
    seedIssue(42, "Add pagination to the API");
    const worktrees = capturingWorktrees();
    const job = createJob({ repoId, issueNumber: 42 }, db);

    await runJob(job.id, deps(worktrees) as never);

    const [, jobId, issueNumber, label] = worktrees.prepare.mock.calls[0] as [
      Repo,
      number,
      number,
      string,
    ];
    expect(jobId).toBe(job.id);
    expect(issueNumber).toBe(42);
    expect(label).toBe("issue-42-add-pagination-to-the-api");
  });

  it("degrades to the id-only label when the issue cache has no title", async () => {
    // No seedIssue: the cache is empty, so branch naming must fall back.
    const worktrees = capturingWorktrees();
    const job = createJob({ repoId, issueNumber: 7 }, db);

    await runJob(job.id, deps(worktrees) as never);

    const label = (worktrees.prepare.mock.calls[0] as unknown[])[3];
    expect(label).toBe("issue-7");
  });
});
