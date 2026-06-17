import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { type Job, jobs } from "@/lib/db/schema";
import type { Worktree } from "@/lib/git/worktree";
import { createJob, getJob } from "@/lib/orchestrator/jobs";
import { runJob } from "@/lib/orchestrator/run-job";
import { TEMPLATE_NAMES } from "@/lib/prompts/defaults";
import { saveTemplate } from "@/lib/prompts/templates";
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

function baseDeps(over: Record<string, unknown> = {}) {
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
    ...over,
  };
}

describe("runJob — implement prompt version recording (issue #178)", () => {
  it("records a null version when the job runs on the code-default template", async () => {
    const repoId = addRepo({ path: "/repo", name: "acme" }, db).id;
    const job = createJob({ repoId, issueNumber: 1 }, db);

    await runJob(job.id, baseDeps() as never);

    expect(getJob(job.id, db)?.implementPromptVersion).toBeNull();
  });

  it("records the resolved version when a repo prompt template is active", async () => {
    const repoId = addRepo({ path: "/repo", name: "acme" }, db).id;
    saveTemplate({ repoId, name: TEMPLATE_NAMES.main, content: "v1 prompt" }, db);
    saveTemplate({ repoId, name: TEMPLATE_NAMES.main, content: "v2 prompt" }, db);
    const job = createJob({ repoId, issueNumber: 1 }, db);

    await runJob(job.id, baseDeps() as never);

    expect(getJob(job.id, db)?.implementPromptVersion).toBe(2);
  });
});
