import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { type Job, jobEvents, jobs } from "@/lib/db/schema";
import type { Worktree } from "@/lib/git/worktree";
import { createJob, getJob } from "@/lib/orchestrator/jobs";
import { MAX_TURN_RESUMES, runJob } from "@/lib/orchestrator/run-job";
import { addRepo } from "@/lib/repos/service";
import { saveSettings } from "@/lib/settings/service";

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

/** A first session that exhausts its positive turn budget (issue #277). */
function maxTurnsSession() {
  return vi.fn(async (job: Job) => {
    db.update(jobs).set({ status: "working", sessionId: "s1" }).where(eq(jobs.id, job.id)).run();
    return {
      exitCode: 1,
      sessionId: "s1",
      costUsd: 0.05,
      inputTokens: 1,
      outputTokens: 1,
      maxTurnsReached: true,
    };
  });
}

function baseDeps(over: Record<string, unknown> = {}) {
  const wt: Worktree = { path: "/wt", branch: "drydock/issue-1-job-1" };
  return {
    db,
    worktrees: {
      prepare: vi.fn(async () => wt),
      commitAndPush: vi.fn(async () => {}),
      commitAndPushForHuman: vi.fn(async () => false),
      remove: vi.fn(async () => {}),
    },
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
    commentIssue: vi.fn(async () => {}),
    notify: vi.fn(async () => {}),
    announceNeedsHuman: vi.fn(async () => {}),
    ...over,
  };
}

/** A job carrying a positive turn budget so its abort reads "turn budget (N)". */
function budgetedJob(issueNumber: number, maxTurns = 5): Job {
  const job = createJob({ repoId, issueNumber }, db);
  db.update(jobs).set({ maxTurns }).where(eq(jobs.id, job.id)).run();
  return getJob(job.id, db) as Job;
}

function eventReasons(jobId: number): string[] {
  return db
    .select()
    .from(jobEvents)
    .where(eq(jobEvents.jobId, jobId))
    .all()
    .map((e) => (JSON.parse(e.payload) as { reason?: string }).reason ?? "");
}

describe("runJob max-turns auto-resume (issue #277)", () => {
  it("auto-resumes a turn-budget-exhausted session instead of parking", async () => {
    const resumeLimitSession = vi.fn(async (job: Job, _prompt: string, _cwd: string) => {
      db.update(jobs).set({ status: "working" }).where(eq(jobs.id, job.id)).run();
      return { exitCode: 0, sessionId: "s1", costUsd: 0.1, inputTokens: 1, outputTokens: 1 };
    });
    const deps = baseDeps({ runSession: maxTurnsSession(), resumeLimitSession });
    const job = budgetedJob(1);
    const result = await runJob(job.id, deps as never);

    expect(result.status).toBe("merged");
    expect(resumeLimitSession).toHaveBeenCalledTimes(1);
    expect(deps.createPr).toHaveBeenCalled();
    // The continuation prompt keeps the job's prior work, not a fresh checkout.
    const prompt = resumeLimitSession.mock.calls[0]?.[1] as string;
    expect(prompt).toMatch(/turn budget/i);
    expect(prompt).toContain("#1");
    // The resume is recorded in the job event log.
    expect(eventReasons(job.id).some((r) => /turn budget \(5\) reached/i.test(r))).toBe(true);
  });

  it("parks with a turn-budget reason when auto-resume is disabled", async () => {
    saveSettings({ maxTurnsAutoResume: false }, db);
    const resumeLimitSession = vi.fn(async () => {
      throw new Error("must not resume");
    });
    const deps = baseDeps({ runSession: maxTurnsSession(), resumeLimitSession });
    const job = budgetedJob(2);
    const result = await runJob(job.id, deps as never);

    expect(result.status).toBe("needs_human");
    expect(result.errorMessage).toMatch(/turn budget \(5\) reached/i);
    expect(result.errorMessage).not.toMatch(/exited non-zero/i);
    expect(resumeLimitSession).not.toHaveBeenCalled();
    expect(deps.createPr).not.toHaveBeenCalled();
  });

  it("escalates to needs_human after exhausting the resume budget", async () => {
    const resumeLimitSession = vi.fn(async (job: Job) => {
      db.update(jobs).set({ status: "working" }).where(eq(jobs.id, job.id)).run();
      return {
        exitCode: 1,
        sessionId: "s1",
        costUsd: 0.05,
        inputTokens: 1,
        outputTokens: 1,
        maxTurnsReached: true,
      };
    });
    const deps = baseDeps({ runSession: maxTurnsSession(), resumeLimitSession });
    const job = budgetedJob(3);
    const result = await runJob(job.id, deps as never);

    expect(result.status).toBe("needs_human");
    expect(result.errorMessage).toMatch(/turn budget \(5\) reached/i);
    // Bounded: it resumes a fixed number of times, never indefinitely.
    expect(resumeLimitSession).toHaveBeenCalledTimes(MAX_TURN_RESUMES);
    expect(deps.createPr).not.toHaveBeenCalled();
  });

  it("does not resume when the session recorded no id to resume from", async () => {
    const noIdSession = vi.fn(async (job: Job) => {
      db.update(jobs).set({ status: "working" }).where(eq(jobs.id, job.id)).run();
      return {
        exitCode: 1,
        sessionId: undefined,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        maxTurnsReached: true,
      };
    });
    const resumeLimitSession = vi.fn(async () => {
      throw new Error("must not resume");
    });
    const deps = baseDeps({ runSession: noIdSession, resumeLimitSession });
    const job = budgetedJob(4);
    const result = await runJob(job.id, deps as never);

    expect(result.status).toBe("needs_human");
    expect(result.errorMessage).toMatch(/turn budget \(5\) reached/i);
    expect(resumeLimitSession).not.toHaveBeenCalled();
  });
});
