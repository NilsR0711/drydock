import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { type Job, jobs } from "@/lib/db/schema";
import type { Worktree } from "@/lib/git/worktree";
import { syncIssuesFromGh } from "@/lib/issues/service";
import { createJob, getJob } from "@/lib/orchestrator/jobs";
import { runJob } from "@/lib/orchestrator/run-job";
import { addRepo } from "@/lib/repos/service";

// Spy on the real resume entrypoint so the stored-session resume path can be
// exercised through runJob's DEFAULT closure (not a dep override) — that closure
// is where `repo.bypassPermissions` is threaded, so overriding the resume dep
// would bypass the very wiring under test (issue #283). The import must follow
// the mock so the bound `resumeAgentSession` resolves to the spy.
vi.mock("@/lib/orchestrator/agent-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/orchestrator/agent-session")>();
  return { ...actual, resumeAgentSession: vi.fn() };
});

import { resumeAgentSession } from "@/lib/orchestrator/agent-session";

let db: DB;
beforeEach(() => {
  db = createDb(":memory:");
  vi.mocked(resumeAgentSession).mockReset();
});

const WT: Worktree = { path: "/wt", branch: "drydock/issue-1-job-1" };

function fakeWorktrees() {
  return {
    prepare: vi.fn(async () => WT),
    prepareResume: vi.fn(async () => WT),
    commitAndPush: vi.fn(async () => {}),
    commitAndPushForHuman: vi.fn(async () => false),
    remove: vi.fn(async () => {}),
  };
}

/**
 * Capture the `bypassPermissions` flag the run-job lifecycle hands to the fresh
 * implement session (issue #283). It is dependency-injected as the 4th
 * positional `runSession` arg, mirroring how `runReleaseJob` threads it.
 */
function deps(seen: { bypass?: boolean; allowed?: string[] }, over: Record<string, unknown> = {}) {
  return {
    db,
    worktrees: fakeWorktrees(),
    runSession: vi.fn(
      async (
        job: Job,
        _p: string,
        _c: string,
        bypassPermissions?: boolean,
        allowedCommands?: string[],
      ) => {
        seen.bypass = bypassPermissions;
        seen.allowed = allowedCommands;
        db.update(jobs)
          .set({ status: "working", sessionId: "s1" })
          .where(eq(jobs.id, job.id))
          .run();
        return { exitCode: 0, sessionId: "s1", costUsd: 0.1, inputTokens: 1, outputTokens: 1 };
      },
    ),
    createPr: vi.fn(async () => 55),
    viewIssue: vi.fn(async () => ({ title: "", body: "" })),
    verify: vi.fn(async () => {}),
    audit: vi.fn(async () => {}),
    runBabysitter: vi.fn(async (job: Job) => {
      db.update(jobs).set({ status: "merged" }).where(eq(jobs.id, job.id)).run();
      return getJob(job.id, db) as Job;
    }),
    notify: vi.fn(async () => {}),
    ...over,
  };
}

/** A job parked on a provider limit: the driver resumes its stored session. */
function limitParkedJob(repoId: number, issueNumber: number): Job {
  const job = createJob({ repoId, issueNumber }, db);
  db.update(jobs)
    .set({ sessionId: "sess-old", limitKind: "usage_limit" })
    .where(eq(jobs.id, job.id))
    .run();
  return getJob(job.id, db) as Job;
}

describe("runJob --dangerously-skip-permissions wiring (issue #283)", () => {
  it("runs the implement session edits-only when the repo has not opted in", async () => {
    const repo = addRepo({ path: "/r", name: "r" }, db);
    syncIssuesFromGh(repo.id, [{ number: 1, title: "T", labels: [] }], db);
    const seen: { bypass?: boolean } = {};
    const job = createJob({ repoId: repo.id, issueNumber: 1 }, db);

    const result = await runJob(job.id, deps(seen) as never);

    expect(result.status).toBe("merged");
    expect(seen.bypass).toBe(false);
  });

  it("runs the implement session with full shell access when the repo opts in", async () => {
    const repo = addRepo({ path: "/r", name: "r", bypassPermissions: true }, db);
    syncIssuesFromGh(repo.id, [{ number: 1, title: "T", labels: [] }], db);
    const seen: { bypass?: boolean } = {};
    const job = createJob({ repoId: repo.id, issueNumber: 1 }, db);

    const result = await runJob(job.id, deps(seen) as never);

    expect(result.status).toBe("merged");
    expect(seen.bypass).toBe(true);
  });

  it("threads the repo's command allowlist into the implement session (issue #329)", async () => {
    const repo = addRepo({ path: "/r", name: "r", allowedCommands: ["git", "xcodebuild"] }, db);
    syncIssuesFromGh(repo.id, [{ number: 1, title: "T", labels: [] }], db);
    const seen: { bypass?: boolean; allowed?: string[] } = {};
    const job = createJob({ repoId: repo.id, issueNumber: 1 }, db);

    const result = await runJob(job.id, deps(seen) as never);

    expect(result.status).toBe("merged");
    // Allowlist is independent of the bypass flag.
    expect(seen.bypass).toBe(false);
    expect(seen.allowed).toEqual(["git", "xcodebuild"]);
  });

  it("carries the opt-in flag into the stored-session resume (limit/instruction resume)", async () => {
    // The limit and human-instruction resume paths share one closure
    // (resumeStoredSession), so exercising the limit-resume path covers both.
    vi.mocked(resumeAgentSession).mockImplementation(async (job: Job) => {
      db.update(jobs).set({ status: "working" }).where(eq(jobs.id, job.id)).run();
      return {
        exitCode: 0,
        sessionId: "sess-old",
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        timedOut: false,
        costExceeded: false,
        maxTurnsReached: false,
      };
    });
    const repo = addRepo(
      { path: "/r", name: "r", bypassPermissions: true, allowedCommands: ["git", "xcodebuild"] },
      db,
    );
    syncIssuesFromGh(repo.id, [{ number: 7, title: "T", labels: [] }], db);
    const job = limitParkedJob(repo.id, 7);

    const result = await runJob(job.id, deps({}) as never);

    expect(result.status).toBe("merged");
    const calls = vi.mocked(resumeAgentSession).mock.calls;
    expect(calls).toHaveLength(1);
    // resumeAgentSession(job, sessionId, failedLog, cwd, options)
    expect(calls[0]?.[4]?.bypassPermissions).toBe(true);
    // The allowlist rides the same resume closure (issue #329).
    expect(calls[0]?.[4]?.allowedCommands).toEqual(["git", "xcodebuild"]);
  });

  it("keeps the stored-session resume edits-only when the repo has not opted in", async () => {
    vi.mocked(resumeAgentSession).mockImplementation(async (job: Job) => {
      db.update(jobs).set({ status: "working" }).where(eq(jobs.id, job.id)).run();
      return {
        exitCode: 0,
        sessionId: "sess-old",
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        timedOut: false,
        costExceeded: false,
        maxTurnsReached: false,
      };
    });
    const repo = addRepo({ path: "/r", name: "r" }, db);
    syncIssuesFromGh(repo.id, [{ number: 8, title: "T", labels: [] }], db);
    const job = limitParkedJob(repo.id, 8);

    const result = await runJob(job.id, deps({}) as never);

    expect(result.status).toBe("merged");
    const calls = vi.mocked(resumeAgentSession).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[4]?.bypassPermissions).toBe(false);
  });
});
