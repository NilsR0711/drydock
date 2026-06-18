import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { type Job, jobs } from "@/lib/db/schema";
import { EmptyCommitError, type Worktree } from "@/lib/git/worktree";
import { syncIssuesFromGh } from "@/lib/issues/service";
import { listSubtasks, replaceSubtasks } from "@/lib/issues/subtasks";
import { createJob, getJob } from "@/lib/orchestrator/jobs";
import { runJob } from "@/lib/orchestrator/run-job";
import { addRepo } from "@/lib/repos/service";

let db: DB;

beforeEach(() => {
  db = createDb(":memory:");
});

interface FakeWorktreeApi {
  prepare: ReturnType<typeof vi.fn>;
  commitAndPush: ReturnType<typeof vi.fn>;
  commitAndPushForHuman: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}

function fakeWorktrees(overrides: Partial<FakeWorktreeApi> = {}): FakeWorktreeApi {
  const wt: Worktree = { path: "/wt", branch: "drydock/issue-1-job-1" };
  return {
    prepare: vi.fn(async () => wt),
    commitAndPush: vi.fn(async () => {}),
    commitAndPushForHuman: vi.fn(async () => false),
    remove: vi.fn(async () => {}),
    ...overrides,
  };
}

function deps(over: Record<string, unknown> = {}) {
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
    notify: vi.fn(async () => {}),
    announceNeedsHuman: vi.fn(async () => {}),
    ...over,
  };
}

describe("runJob with decomposed subtasks", () => {
  it("injects the subtask checklist into the prompt and marks them done on merge", async () => {
    const repo = addRepo({ path: "/r", name: "r", autoDecompose: true }, db);
    syncIssuesFromGh(repo.id, [{ number: 1, title: "Big", labels: [] }], db);
    replaceSubtasks(repo.id, 1, ["Add API", "Wire UI"], "h", db);

    const d = deps();
    const job = createJob({ repoId: repo.id, issueNumber: 1 }, db);
    const result = await runJob(job.id, d as never);

    expect(result.status).toBe("merged");
    const prompt = (d.runSession as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(prompt).toContain("## Subtasks");
    expect(prompt).toContain("1. [ ] Add API");
    expect(prompt).toContain("2. [ ] Wire UI");
    expect(listSubtasks(repo.id, 1, db).every((s) => s.status === "done")).toBe(true);
  });

  it("does not touch the prompt or subtasks when the repo has not opted in", async () => {
    const repo = addRepo({ path: "/r", name: "r", autoDecompose: false }, db);
    syncIssuesFromGh(repo.id, [{ number: 1, title: "Big", labels: [] }], db);
    replaceSubtasks(repo.id, 1, ["Add API", "Wire UI"], "h", db);

    const d = deps();
    const job = createJob({ repoId: repo.id, issueNumber: 1 }, db);
    await runJob(job.id, d as never);

    const prompt = (d.runSession as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(prompt).not.toContain("## Subtasks");
    expect(listSubtasks(repo.id, 1, db).every((s) => s.status === "pending")).toBe(true);
  });

  it("parks subtasks as pending when the babysitter does not merge (issue #96)", async () => {
    const repo = addRepo({ path: "/r", name: "r", autoDecompose: true }, db);
    syncIssuesFromGh(repo.id, [{ number: 1, title: "Big", labels: [] }], db);
    replaceSubtasks(repo.id, 1, ["Add API", "Wire UI"], "h", db);

    const d = deps({
      runBabysitter: vi.fn(async (job: Job) => {
        db.update(jobs).set({ status: "needs_human" }).where(eq(jobs.id, job.id)).run();
        return getJob(job.id, db) as Job;
      }),
    });
    const job = createJob({ repoId: repo.id, issueNumber: 1 }, db);
    const result = await runJob(job.id, d as never);

    expect(result.status).toBe("needs_human");
    expect(listSubtasks(repo.id, 1, db).every((s) => s.status === "pending")).toBe(true);
  });

  it("parks subtasks as pending on agent timeout (issue #96)", async () => {
    const repo = addRepo({ path: "/r", name: "r", autoDecompose: true }, db);
    syncIssuesFromGh(repo.id, [{ number: 1, title: "Big", labels: [] }], db);
    replaceSubtasks(repo.id, 1, ["Step 1", "Step 2"], "h", db);

    const d = deps({
      runSession: vi.fn(async (job: Job) => {
        db.update(jobs)
          .set({ status: "working", sessionId: "s1" })
          .where(eq(jobs.id, job.id))
          .run();
        return {
          exitCode: 1,
          timedOut: true,
          sessionId: "s1",
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
        };
      }),
    });
    const job = createJob({ repoId: repo.id, issueNumber: 1 }, db);
    const result = await runJob(job.id, d as never);

    expect(result.status).toBe("needs_human");
    expect(listSubtasks(repo.id, 1, db).every((s) => s.status === "pending")).toBe(true);
  });

  it("parks subtasks as pending when per-job cost cap is reached (issue #96)", async () => {
    const repo = addRepo({ path: "/r", name: "r", autoDecompose: true }, db);
    syncIssuesFromGh(repo.id, [{ number: 1, title: "Big", labels: [] }], db);
    replaceSubtasks(repo.id, 1, ["Step 1", "Step 2"], "h", db);

    const d = deps({
      runSession: vi.fn(async (job: Job) => {
        db.update(jobs)
          .set({ status: "working", sessionId: "s1" })
          .where(eq(jobs.id, job.id))
          .run();
        return {
          exitCode: 1,
          costExceeded: true,
          sessionId: "s1",
          costUsd: 5,
          inputTokens: 100,
          outputTokens: 100,
        };
      }),
    });
    const job = createJob({ repoId: repo.id, issueNumber: 1 }, db);
    const result = await runJob(job.id, d as never);

    expect(result.status).toBe("needs_human");
    expect(listSubtasks(repo.id, 1, db).every((s) => s.status === "pending")).toBe(true);
  });

  it("parks subtasks as pending on non-zero agent exit (issue #96)", async () => {
    const repo = addRepo({ path: "/r", name: "r", autoDecompose: true }, db);
    syncIssuesFromGh(repo.id, [{ number: 1, title: "Big", labels: [] }], db);
    replaceSubtasks(repo.id, 1, ["Step 1", "Step 2"], "h", db);

    const d = deps({
      runSession: vi.fn(async (job: Job) => {
        db.update(jobs)
          .set({ status: "working", sessionId: "s1" })
          .where(eq(jobs.id, job.id))
          .run();
        return { exitCode: 1, sessionId: "s1", costUsd: 0, inputTokens: 0, outputTokens: 0 };
      }),
    });
    const job = createJob({ repoId: repo.id, issueNumber: 1 }, db);
    const result = await runJob(job.id, d as never);

    expect(result.status).toBe("needs_human");
    expect(listSubtasks(repo.id, 1, db).every((s) => s.status === "pending")).toBe(true);
  });

  it("parks subtasks as pending when agent produces no changes (EmptyCommitError) (issue #96)", async () => {
    const repo = addRepo({ path: "/r", name: "r", autoDecompose: true }, db);
    syncIssuesFromGh(repo.id, [{ number: 1, title: "Big", labels: [] }], db);
    replaceSubtasks(repo.id, 1, ["Step 1", "Step 2"], "h", db);

    const wt: Worktree = { path: "/wt", branch: "drydock/issue-1-job-1" };
    const d = deps({
      worktrees: {
        prepare: vi.fn(async () => wt),
        commitAndPush: vi.fn(async () => {
          throw new EmptyCommitError();
        }),
        commitAndPushForHuman: vi.fn(async () => false),
        remove: vi.fn(async () => {}),
      },
    });
    const job = createJob({ repoId: repo.id, issueNumber: 1 }, db);
    const result = await runJob(job.id, d as never);

    expect(result.status).toBe("needs_human");
    expect(listSubtasks(repo.id, 1, db).every((s) => s.status === "pending")).toBe(true);
  });

  it("parks subtasks as pending when an unexpected error is thrown (issue #96)", async () => {
    const repo = addRepo({ path: "/r", name: "r", autoDecompose: true }, db);
    syncIssuesFromGh(repo.id, [{ number: 1, title: "Big", labels: [] }], db);
    replaceSubtasks(repo.id, 1, ["Step 1", "Step 2"], "h", db);

    const d = deps({
      runSession: vi.fn(async () => {
        throw new Error("unexpected internal failure");
      }),
    });
    const job = createJob({ repoId: repo.id, issueNumber: 1 }, db);
    const result = await runJob(job.id, d as never);

    expect(result.status).toBe("needs_human");
    expect(listSubtasks(repo.id, 1, db).every((s) => s.status === "pending")).toBe(true);
  });

  it("does not park subtasks when autoDecompose is off, even if subtasks exist (issue #96)", async () => {
    const repo = addRepo({ path: "/r", name: "r", autoDecompose: false }, db);
    syncIssuesFromGh(repo.id, [{ number: 1, title: "Big", labels: [] }], db);
    replaceSubtasks(repo.id, 1, ["Step 1", "Step 2"], "h", db);

    const d = deps({
      runSession: vi.fn(async (job: Job) => {
        db.update(jobs)
          .set({ status: "working", sessionId: "s1" })
          .where(eq(jobs.id, job.id))
          .run();
        return { exitCode: 1, sessionId: "s1", costUsd: 0, inputTokens: 0, outputTokens: 0 };
      }),
    });
    const job = createJob({ repoId: repo.id, issueNumber: 1 }, db);
    await runJob(job.id, d as never);

    // Not autoDecompose: subtasks should be untouched (still pending)
    expect(listSubtasks(repo.id, 1, db).every((s) => s.status === "pending")).toBe(true);
  });
});
