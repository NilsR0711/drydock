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
    ...over,
  };
}

describe("runJob — implement prompt version recording (issue #178)", () => {
  it("records a null version when the job runs on the code-default template", async () => {
    const repoId = addRepo(
      { verifyPr: false, autoPrAudit: false, path: "/repo", name: "acme" },
      db,
    ).id;
    const job = createJob({ repoId, issueNumber: 1 }, db);

    await runJob(job.id, baseDeps() as never);

    expect(getJob(job.id, db)?.implementPromptVersion).toBeNull();
  });

  it("records the resolved version when a repo prompt template is active", async () => {
    const repoId = addRepo(
      { verifyPr: false, autoPrAudit: false, path: "/repo", name: "acme" },
      db,
    ).id;
    saveTemplate({ repoId, name: TEMPLATE_NAMES.main, content: "v1 prompt" }, db);
    saveTemplate({ repoId, name: TEMPLATE_NAMES.main, content: "v2 prompt" }, db);
    const job = createJob({ repoId, issueNumber: 1 }, db);

    await runJob(job.id, baseDeps() as never);

    expect(getJob(job.id, db)?.implementPromptVersion).toBe(2);
  });

  it("preserves the version across a limit resume without re-resolving the prompt", async () => {
    const repoId = addRepo(
      { verifyPr: false, autoPrAudit: false, path: "/repo", name: "acme" },
      db,
    ).id;
    const job = createJob({ repoId, issueNumber: 1 }, db);
    // Simulate a job whose first fresh run recorded version 2 and then parked
    // on a provider limit: the resume path must not touch implementPromptVersion.
    db.update(jobs)
      .set({ implementPromptVersion: 2, sessionId: "sess-old", limitKind: "usage_limit" })
      .where(eq(jobs.id, job.id))
      .run();

    const resumeLimitSession = vi.fn(async (j: Job) => {
      db.update(jobs).set({ status: "working" }).where(eq(jobs.id, j.id)).run();
      return { exitCode: 0, sessionId: "sess-old", costUsd: 0.1, inputTokens: 1, outputTokens: 1 };
    });
    const runSession = vi.fn(async () => {
      throw new Error("a fresh session must not run on a limit resume");
    });

    await runJob(
      job.id,
      baseDeps({ resumeLimitSession, runSession, commentIssue: vi.fn() }) as never,
    );

    expect(resumeLimitSession).toHaveBeenCalledTimes(1);
    expect(runSession).not.toHaveBeenCalled();
    expect(getJob(job.id, db)?.implementPromptVersion).toBe(2);
  });
});
