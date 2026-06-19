import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { type Job, jobEvents, jobs } from "@/lib/db/schema";
import type { Worktree } from "@/lib/git/worktree";
import { createJob, getJob } from "@/lib/orchestrator/jobs";
import { resumeJobWithInstruction } from "@/lib/orchestrator/resume-instruction";
import { runJob } from "@/lib/orchestrator/run-job";
import { addRepo } from "@/lib/repos/service";

let db: DB;
let repoId: number;

beforeEach(() => {
  db = createDb(":memory:");
  repoId = addRepo(
    {
      verifyPr: false,
      autoPrAudit: false,
      path: "/repo",
      name: "acme",
      defaultModel: "claude-opus-4-8",
    },
    db,
  ).id;
});

const PRESERVED_BRANCH = "drydock/issue-1-job-1";

/**
 * A needs_human job with a pushed branch + recorded session, then unblocked with
 * a typed instruction — the exact state a human leaves behind on the
 * needs_human screen.
 */
function unblockedJob(instruction: string, over: { sessionId?: string | null } = {}) {
  const job = createJob({ repoId, issueNumber: 1 }, db);
  db.update(jobs)
    .set({
      status: "needs_human",
      branch: PRESERVED_BRANCH,
      sessionId: "sessionId" in over ? over.sessionId : "sess-1",
    })
    .where(eq(jobs.id, job.id))
    .run();
  resumeJobWithInstruction(job.id, instruction, db);
  return getJob(job.id, db) as Job;
}

function baseDeps(over: Record<string, unknown> = {}) {
  const wt: Worktree = { path: "/wt", branch: PRESERVED_BRANCH, base: "base-sha" };
  return {
    db,
    worktrees: {
      prepare: vi.fn(async () => wt),
      prepareResume: vi.fn(async () => wt),
      commitAndPush: vi.fn(async () => {}),
      commitAndPushForHuman: vi.fn(async () => true),
      remove: vi.fn(async () => {}),
    },
    runSession: vi.fn(async (job: Job, _prompt: string, _cwd: string) => {
      db.update(jobs)
        .set({ status: "working", sessionId: "sess-2" })
        .where(eq(jobs.id, job.id))
        .run();
      return { exitCode: 0, sessionId: "sess-2", costUsd: 0.1, inputTokens: 1, outputTokens: 1 };
    }),
    resumeInstructionSession: vi.fn(async (job: Job, _prompt: string, _cwd: string) => {
      db.update(jobs).set({ status: "working" }).where(eq(jobs.id, job.id)).run();
      return { exitCode: 0, sessionId: "sess-1", costUsd: 0.1, inputTokens: 1, outputTokens: 1 };
    }),
    createPr: vi.fn(async () => 55),
    viewIssue: vi.fn(async () => ({ title: "", body: "" })),
    runBabysitter: vi.fn(async (job: Job) => {
      db.update(jobs).set({ status: "merged" }).where(eq(jobs.id, job.id)).run();
      return getJob(job.id, db) as Job;
    }),
    commentIssue: vi.fn(async () => {}),
    notify: vi.fn(async () => {}),
    ...over,
  };
}

function eventReasons(jobId: number): string[] {
  return db
    .select()
    .from(jobEvents)
    .where(eq(jobEvents.jobId, jobId))
    .all()
    .map((e) => (JSON.parse(e.payload) as { reason?: string }).reason ?? "");
}

describe("runJob human-guided resume (issue #257)", () => {
  it("resumes the stored session on the preserved branch, not a fresh one", async () => {
    const deps = baseDeps();
    const job = unblockedJob("use the existing xByY helper");
    await runJob(job.id, deps as never);

    // The job continues on its existing branch (checked out), not a new one.
    expect(deps.worktrees.prepareResume).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Number),
      PRESERVED_BRANCH,
    );
    expect(deps.worktrees.prepare).not.toHaveBeenCalled();
    // The resume runner is used, not a fresh implement session.
    expect(deps.resumeInstructionSession).toHaveBeenCalled();
    expect(deps.runSession).not.toHaveBeenCalled();
  });

  it("feeds the human instruction into the resume prompt", async () => {
    const deps = baseDeps();
    const job = unblockedJob("skip the migration, it is already applied");
    await runJob(job.id, deps as never);

    const prompt = deps.resumeInstructionSession.mock.calls[0]?.[1] as string;
    expect(prompt).toContain("skip the migration, it is already applied");
  });

  it("clears the instruction marker so a re-run does not re-trigger the resume", async () => {
    const deps = baseDeps();
    const job = unblockedJob("do the thing");
    await runJob(job.id, deps as never);
    expect(getJob(job.id, db)?.humanInstruction).toBeNull();
  });

  it("records a status event noting the human-guided resume", async () => {
    const deps = baseDeps();
    const job = unblockedJob("do the thing");
    await runJob(job.id, deps as never);
    expect(eventReasons(job.id).some((r) => /human instruction/i.test(r))).toBe(true);
  });

  it("reuses the existing PR instead of re-running createPr (issue #331)", async () => {
    const deps = baseDeps();
    const job = unblockedJob("resolve the conflicts");
    // A resume on a branch that already has an open PR: prNumber is set, exactly
    // the state a fix-an-existing-PR job carries.
    db.update(jobs).set({ prNumber: 238 }).where(eq(jobs.id, job.id)).run();
    await runJob(job.id, deps as never);

    // The finish path must not re-open a PR — `gh pr create` errors with
    // "already exists" there and falsely parks the job as needs_human.
    expect(deps.createPr).not.toHaveBeenCalled();
    // It proceeds straight back to CI on the existing PR number.
    expect(deps.runBabysitter).toHaveBeenCalledWith(expect.anything(), 238);
    expect(getJob(job.id, db)?.status).toBe("merged");
  });

  it("falls back to a fresh run with the instruction in the prompt when no session can be resumed", async () => {
    const deps = baseDeps();
    // No stored session id → nothing to --resume; must still carry the guidance.
    const job = unblockedJob("prefer the v2 API", { sessionId: null });
    await runJob(job.id, deps as never);

    expect(deps.resumeInstructionSession).not.toHaveBeenCalled();
    expect(deps.runSession).toHaveBeenCalled();
    const prompt = deps.runSession.mock.calls[0]?.[1] as string;
    expect(prompt).toContain("prefer the v2 API");
    // Even on the fresh-run fallback the preserved branch is reused, so the run
    // builds on the prior commits rather than a blank branch.
    expect(deps.worktrees.prepareResume).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Number),
      PRESERVED_BRANCH,
    );
    expect(deps.worktrees.prepare).not.toHaveBeenCalled();
  });
});
