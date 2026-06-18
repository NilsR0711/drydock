import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { type Job, jobs } from "@/lib/db/schema";
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

/** A worktree stub whose commit/push are spies; path "/wt" feeds the metadata reader. */
function fakeWorktrees() {
  const wt: Worktree = { path: "/wt", branch: "drydock/issue-1-job-1" };
  return {
    prepare: vi.fn(async () => wt),
    commitAndPush: vi.fn(async () => {}),
    commitAndPushForHuman: vi.fn(async () => false),
    remove: vi.fn(async () => {}),
  };
}

interface PrInput {
  head: string;
  base: string;
  title: string;
  body: string;
}

/** Build runJob deps that drive a job straight to merged, capturing the PR input. */
function baseDeps(over: Record<string, unknown> = {}) {
  const captured: { pr?: PrInput } = {};
  const deps = {
    db,
    worktrees: fakeWorktrees(),
    runSession: vi.fn(async (job: Job) => {
      db.update(jobs).set({ status: "working", sessionId: "s1" }).where(eq(jobs.id, job.id)).run();
      return { exitCode: 0, sessionId: "s1", costUsd: 0.1, inputTokens: 1, outputTokens: 1 };
    }),
    createPr: vi.fn(async (input: PrInput) => {
      captured.pr = input;
      return 55;
    }),
    viewIssue: vi.fn(async () => ({ title: "Issue title", body: "Issue body" })),
    runBabysitter: vi.fn(async (job: Job) => {
      db.update(jobs).set({ status: "merged" }).where(eq(jobs.id, job.id)).run();
      return getJob(job.id, db) as Job;
    }),
    ...over,
  };
  return { deps, captured };
}

describe("runJob — agent-authored PR metadata (issue #212)", () => {
  it("uses the metadata title for the commit and PR, and appends Closes #N to the body", async () => {
    const consumePrMetadata = vi.fn(() => ({
      title: "feat(api): paginate issues",
      body: "## Problem\nReturned everything.\n\n## Solution\nAdd a cursor.",
    }));
    const { deps, captured } = baseDeps({ consumePrMetadata });
    const job = createJob({ repoId, issueNumber: 1 }, db);

    await runJob(job.id, deps as never);

    expect(consumePrMetadata).toHaveBeenCalledWith("/wt");
    expect(deps.worktrees.commitAndPush).toHaveBeenCalledWith(
      expect.anything(),
      "feat(api): paginate issues",
    );
    expect(deps.createPr).toHaveBeenCalledTimes(1);
    expect(captured.pr?.title).toBe("feat(api): paginate issues");
    expect(captured.pr?.body).toContain("## Problem");
    expect(captured.pr?.body).toContain("## Solution");
    expect(captured.pr?.body).toContain("Closes #1");
  });

  it("falls back to the current behavior when no metadata file is present", async () => {
    const consumePrMetadata = vi.fn(() => null);
    const { deps, captured } = baseDeps({ consumePrMetadata });
    const job = createJob({ repoId, issueNumber: 7 }, db);

    await runJob(job.id, deps as never);

    expect(deps.worktrees.commitAndPush).toHaveBeenCalledWith(expect.anything(), "Fix #7");
    expect(captured.pr?.body).toBe("Closes #7");
  });
});
