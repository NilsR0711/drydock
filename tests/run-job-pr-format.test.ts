import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { type Job, jobs } from "@/lib/db/schema";
import type { Worktree } from "@/lib/git/worktree";
import { createJob, getJob } from "@/lib/orchestrator/jobs";
import { runJob } from "@/lib/orchestrator/run-job";
import { DEFAULT_TEMPLATES, TEMPLATE_NAMES } from "@/lib/prompts/defaults";
import { saveTemplate } from "@/lib/prompts/templates";
import { addRepo } from "@/lib/repos/service";

let db: DB;
let repoId: number;
beforeEach(() => {
  db = createDb(":memory:");
  repoId = addRepo({ verifyPr: false, autoPrAudit: false, path: "/repo", name: "acme" }, db).id;
});

function fakeWorktrees() {
  const wt: Worktree = { path: "/wt", branch: "drydock/issue-1-job-1" };
  return {
    prepare: vi.fn(async () => wt),
    commitAndPush: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  };
}

/** Captures the prompt handed to the spawned session for assertions. */
function capturingDeps(over: Record<string, unknown> = {}) {
  const captured: { prompt?: string } = {};
  const deps = {
    db,
    worktrees: fakeWorktrees(),
    viewIssue: vi.fn(async () => ({ title: "Issue title", body: "Issue body" })),
    runSession: vi.fn(async (job: Job, prompt: string) => {
      captured.prompt = prompt;
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
  return { deps, captured };
}

describe("runJob — PR-format injection (issue #252)", () => {
  it("injects the default pr-format body into the implement prompt, with no raw token left", async () => {
    const { deps, captured } = capturingDeps();
    const job = createJob({ repoId, issueNumber: 1 }, db);

    await runJob(job.id, deps as never);

    // The resolved pr-format default (TL;DR-first) lands in the prompt verbatim.
    expect(captured.prompt).toContain("TL;DR");
    expect(captured.prompt).toContain(DEFAULT_TEMPLATES[TEMPLATE_NAMES.prFormat]);
    // The injection token must be substituted, not leaked.
    expect(captured.prompt).not.toContain("$PR_FORMAT");
  });

  it("injects a per-repo pr-format override into the implement prompt", async () => {
    saveTemplate(
      { repoId, name: TEMPLATE_NAMES.prFormat, content: "CUSTOM_PR_SHAPE_SENTINEL" },
      db,
    );
    const { deps, captured } = capturingDeps();
    const job = createJob({ repoId, issueNumber: 1 }, db);

    await runJob(job.id, deps as never);

    expect(captured.prompt).toContain("CUSTOM_PR_SHAPE_SENTINEL");
    expect(captured.prompt).not.toContain("$PR_FORMAT");
  });
});
