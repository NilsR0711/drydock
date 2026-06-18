import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { type Job, jobs } from "@/lib/db/schema";
import type { Worktree } from "@/lib/git/worktree";
import { createJob, getJob } from "@/lib/orchestrator/jobs";
import { runReleaseJob } from "@/lib/orchestrator/release-job";
import {
  createReleaseRun,
  findReleaseRunByJob,
  getReleaseRun,
} from "@/lib/release/release-service";
import { addRepo } from "@/lib/repos/service";
import { saveSettings } from "@/lib/settings/service";

let db: DB;
let repoId: number;
beforeEach(() => {
  db = createDb(":memory:");
  saveSettings({ releaseManagementEnabled: true }, db);
  repoId = addRepo({ path: "/repo", name: "acme", releaseEnabled: true, agent: "claude" }, db).id;
});

function fakeWorktrees() {
  const wt: Worktree = { path: "/wt", branch: "drydock/release-job-1" };
  return {
    prepare: vi.fn(async () => wt),
    remove: vi.fn(async () => {}),
  };
}

/** A queued release job plus its linked agent release run, as the action makes them. */
function releaseJobWithRun() {
  const job = createJob({ repoId, issueNumber: 0, kind: "release", agent: "claude" }, db);
  createReleaseRun({ repoId, mode: "agent", jobId: job.id }, db);
  return getJob(job.id, db) as Job;
}

function baseDeps(over: Record<string, unknown> = {}) {
  return {
    db,
    worktrees: fakeWorktrees(),
    runSession: vi.fn(async (job: Job) => {
      db.update(jobs).set({ status: "working", sessionId: "s1" }).where(eq(jobs.id, job.id)).run();
      return { exitCode: 0, sessionId: "s1", costUsd: 0.2, inputTokens: 1, outputTokens: 1 };
    }),
    consumeQuestions: vi.fn(() => null),
    consumeReleaseMetadata: vi.fn(() => ({ tag: "v1.2.0", title: "v1.2.0", notes: "- shipped" })),
    ...over,
  };
}

describe("runReleaseJob (issue #256)", () => {
  it("runs the agent and settles the job released + the run published", async () => {
    const job = releaseJobWithRun();
    const deps = baseDeps();
    const result = await runReleaseJob(job.id, deps as never);

    expect(result.status).toBe("released");
    const run = findReleaseRunByJob(job.id, db);
    expect(run?.status).toBe("published");
    expect(run?.tag).toBe("v1.2.0");
    expect(run?.notes).toBe("- shipped");
    // The agent performs its own pushes — Drydock removes the throwaway worktree.
    expect(deps.worktrees.remove).toHaveBeenCalled();
  });

  it("spawns the session with full shell access (bypassPermissions)", async () => {
    const job = releaseJobWithRun();
    // Default runSession captures nothing; use the real default path by spying
    // on a session that records the bypass flag via a custom dep.
    const seen: { bypass?: boolean } = {};
    const deps = baseDeps({
      runSession: vi.fn(async (j: Job, _p: string, _c: string, bypass?: boolean) => {
        seen.bypass = bypass;
        db.update(jobs).set({ status: "working" }).where(eq(jobs.id, j.id)).run();
        return { exitCode: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };
      }),
    });
    await runReleaseJob(job.id, deps as never);
    expect(seen.bypass).toBe(true);
  });

  it("parks the job in needs_human when the agent writes open questions", async () => {
    const job = releaseJobWithRun();
    const deps = baseDeps({
      consumeQuestions: vi.fn(() => "Which release flow does this repo use?"),
    });
    const result = await runReleaseJob(job.id, deps as never);

    expect(result.status).toBe("needs_human");
    expect(getReleaseRun(findReleaseRunByJob(job.id, db)?.id ?? 0, db)?.status).toBe("error");
    expect(deps.worktrees.remove).toHaveBeenCalled();
  });

  it("escalates to needs_human on a non-zero agent exit", async () => {
    const job = releaseJobWithRun();
    const deps = baseDeps({
      runSession: vi.fn(async (j: Job) => {
        db.update(jobs).set({ status: "working" }).where(eq(jobs.id, j.id)).run();
        return { exitCode: 1, costUsd: 0, inputTokens: 0, outputTokens: 0 };
      }),
    });
    const result = await runReleaseJob(job.id, deps as never);
    expect(result.status).toBe("needs_human");
    expect(findReleaseRunByJob(job.id, db)?.status).toBe("error");
  });

  it("escalates to needs_human when the session times out", async () => {
    const job = releaseJobWithRun();
    const deps = baseDeps({
      runSession: vi.fn(async (j: Job) => {
        db.update(jobs).set({ status: "working" }).where(eq(jobs.id, j.id)).run();
        return { exitCode: -1, timedOut: true, costUsd: 0, inputTokens: 0, outputTokens: 0 };
      }),
    });
    const result = await runReleaseJob(job.id, deps as never);
    expect(result.status).toBe("needs_human");
  });

  it("notifies release_published on success", async () => {
    const job = releaseJobWithRun();
    const notify = vi.fn(async () => {});
    await runReleaseJob(job.id, baseDeps() as never, notify);
    expect(notify).toHaveBeenCalledWith("release_published", expect.stringContaining("v1.2.0"));
  });

  it("settles the run as errored when the job is aborted mid-session", async () => {
    const job = releaseJobWithRun();
    const deps = baseDeps({
      runSession: vi.fn(async (j: Job) => {
        // Simulate an out-of-band abort landing while the session ran.
        db.update(jobs).set({ status: "aborted" }).where(eq(jobs.id, j.id)).run();
        return { exitCode: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };
      }),
    });
    const result = await runReleaseJob(job.id, deps as never);
    expect(result.status).toBe("aborted");
    // The run must not linger in `evaluating` (it would block the next release).
    expect(findReleaseRunByJob(job.id, db)?.status).toBe("error");
    expect(deps.worktrees.remove).toHaveBeenCalled();
  });

  it("removes the worktree even when the session throws", async () => {
    const job = releaseJobWithRun();
    const deps = baseDeps({
      runSession: vi.fn(async () => {
        throw new Error("spawn boom");
      }),
    });
    const result = await runReleaseJob(job.id, deps as never);
    expect(result.status).toBe("needs_human");
    expect(deps.worktrees.remove).toHaveBeenCalled();
  });
});
