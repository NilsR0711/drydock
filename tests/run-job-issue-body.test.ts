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
  repoId = addRepo({ path: "/repo", name: "acme" }, db).id;
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

/** Captures the prompt handed to the spawned session for assertions. */
function capturingDeps(over: Record<string, unknown> = {}) {
  const captured: { prompt?: string } = {};
  const deps = {
    db,
    worktrees: fakeWorktrees(),
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

describe("runJob — issue body embedded in the implement prompt (issue #205)", () => {
  it("embeds the fetched issue title and body in the session prompt", async () => {
    const viewIssue = vi.fn(async () => ({
      title: "Server crashes on startup",
      body: "When the DB file is missing the process exits with code 1.",
    }));
    const { deps, captured } = capturingDeps({ viewIssue });
    const job = createJob({ repoId, issueNumber: 1 }, db);

    await runJob(job.id, deps as never);

    expect(viewIssue).toHaveBeenCalledWith(1);
    expect(captured.prompt).toContain("Server crashes on startup");
    expect(captured.prompt).toContain("When the DB file is missing the process exits with code 1.");
    // The placeholder tokens must be substituted, not left raw.
    expect(captured.prompt).not.toContain("$ISSUE_TITLE");
    expect(captured.prompt).not.toContain("$ISSUE_BODY");
  });

  it("caps an oversized issue title and body so the prompt stays bounded", async () => {
    const hugeTitle = `${"T".repeat(2_000)}TITLE_TAIL_SENTINEL`;
    const hugeBody = `${"B".repeat(50_000)}BODY_TAIL_SENTINEL`;
    const viewIssue = vi.fn(async () => ({ title: hugeTitle, body: hugeBody }));
    const { deps, captured } = capturingDeps({ viewIssue });
    const job = createJob({ repoId, issueNumber: 1 }, db);

    await runJob(job.id, deps as never);

    // The leading content survives, but the oversized tails are dropped with a
    // clear marker so the prompt cannot blow the model's context window.
    expect(captured.prompt).toContain("… (truncated)");
    expect(captured.prompt).not.toContain("TITLE_TAIL_SENTINEL");
    expect(captured.prompt).not.toContain("BODY_TAIL_SENTINEL");
  });

  it("falls back to empty context (no raw tokens) and still drives the job when the fetch fails", async () => {
    const viewIssue = vi.fn(async () => {
      throw new Error("gh: not authenticated");
    });
    const { deps, captured } = capturingDeps({ viewIssue });
    const job = createJob({ repoId, issueNumber: 1 }, db);

    const result = await runJob(job.id, deps as never);

    expect(result.status).toBe("merged");
    expect(deps.runSession).toHaveBeenCalledTimes(1);
    // A failed fetch must not leak the raw template tokens into the prompt.
    expect(captured.prompt).not.toContain("$ISSUE_TITLE");
    expect(captured.prompt).not.toContain("$ISSUE_BODY");
  });
});
