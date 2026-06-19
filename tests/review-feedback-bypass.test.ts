import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import type { Job, Repo } from "@/lib/db/schema";
import type { ForgeClient, ReviewThread } from "@/lib/forge/types";
import type { Worktree } from "@/lib/git/worktree";
import { syncIssuesFromGh } from "@/lib/issues/service";
import { createJob, transitionJob } from "@/lib/orchestrator/jobs";
import { addRepo } from "@/lib/repos/service";

// `defaultProcessJob` persists via the process-wide getDb() singleton, not the
// db handed to driveReviewFeedback. Point getDb() at the test's in-memory DB so
// the job created here and the feedback item written there share one database
// (otherwise the item insert trips the jobId foreign key).
const dbHolder = vi.hoisted(() => ({ current: undefined as DB | undefined }));
vi.mock("@/lib/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/client")>();
  return { ...actual, getDb: () => dbHolder.current as DB };
});

// Mock the agent-session module so the production `defaultProcessJob` composition
// runs end-to-end (forge → processPrFeedback → buildAgentApply → spawnAgentSession)
// without spawning a real agent. This is the only seam that captures the spawn
// options, where `repo.bypassPermissions` must be threaded (issue #328).
//
// The spy lives in a hoisted holder, not an imported binding: the driver imports
// `./agent-session` (relative) while this file would import the `@/`-aliased path,
// and Vitest resolves those to distinct module records — an imported binding here
// would observe zero calls even though the driver hit the mock. Asserting on the
// shared hoisted spy sidesteps that.
const spawnSpy = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({
    exitCode: 0,
    sessionId: "s1",
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    timedOut: false,
    costExceeded: false,
    maxTurnsReached: false,
  })),
);
vi.mock("@/lib/orchestrator/agent-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/orchestrator/agent-session")>();
  return { ...actual, spawnAgentSession: spawnSpy };
});

// Stub the worktree so the side session never touches real git: the apply path
// checks out the PR branch, runs the agent, then commits — all no-ops here.
vi.mock("@/lib/git/worktree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/git/worktree")>();
  const wt: Worktree = { path: "/wt", branch: "drydock/issue-1-job-1" };
  return {
    ...actual,
    WorktreeManager: class {
      prepareForBranch = vi.fn(async () => wt);
      commitAndPush = vi.fn(async () => undefined);
      remove = vi.fn(async () => undefined);
    },
  };
});

import { driveReviewFeedback } from "@/lib/orchestrator/review-feedback-driver";

let db: DB;

beforeEach(() => {
  db = createDb(":memory:");
  dbHolder.current = db;
  spawnSpy.mockClear();
});

/** A forge exposing the review-thread surface, returning one actionable thread
 * authored by a trusted reviewer so the apply (and thus the spawn) is reached. */
function reviewForge(): ForgeClient {
  const thread: ReviewThread = {
    id: "T1",
    isResolved: false,
    isOutdated: false,
    path: "src/a.ts",
    line: 1,
    comments: [{ id: "C1", databaseId: 1, author: "alice", body: "Please rename this variable." }],
  };
  return {
    listReviewThreads: vi.fn(async () => [thread]),
    replyToReviewThread: vi.fn(async () => undefined),
    updateReviewComment: vi.fn(async () => undefined),
    resolveReviewThread: vi.fn(async () => undefined),
    reactToReviewComment: vi.fn(async () => undefined),
  } as unknown as ForgeClient;
}

/** A job that has reached a PR (prNumber + branch set), eligible for the sweep.
 * The issue is synced first so the job (and its review-feedback item) satisfies
 * the FK chain when processPrFeedback persists the item. */
function jobWithPr(repo: Repo, issue: number, pr: number): Job {
  syncIssuesFromGh(repo.id, [{ number: issue, title: "T", labels: [] }], db);
  const j = createJob({ repoId: repo.id, issueNumber: issue }, db);
  transitionJob(j.id, "working", {}, db);
  return transitionJob(
    j.id,
    "ci_running",
    { prNumber: pr, branch: `drydock/issue-${issue}-job-${j.id}` },
    db,
  );
}

describe("review-feedback side session — bypassPermissions wiring (issue #328)", () => {
  it("forwards repo.bypassPermissions to the spawned side session when opted in", async () => {
    const repo = addRepo(
      { path: "/r", name: "r", bypassPermissions: true, trustedReviewers: ["alice"] },
      db,
    );
    jobWithPr(repo, 1, 5);

    await driveReviewFeedback({ db, forgeFor: () => reviewForge() });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    // spawnAgentSession(job, prompt, cwd, deps) — the 4th arg carries the flags.
    expect(spawnDeps()?.bypassPermissions).toBe(true);
    // Must stay a side session: a normal spawn would throw an invalid transition.
    expect(spawnDeps()?.sideSession).toBe(true);
  });

  it("keeps the side session edits-only when the repo has not opted in", async () => {
    const repo = addRepo({ path: "/r", name: "r", trustedReviewers: ["alice"] }, db);
    jobWithPr(repo, 1, 5);

    await driveReviewFeedback({ db, forgeFor: () => reviewForge() });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(spawnDeps()?.bypassPermissions).toBe(false);
  });
});

/** The spawn options (4th positional arg) from the single recorded spawn call. */
function spawnDeps(): { bypassPermissions?: boolean; sideSession?: boolean } | undefined {
  return spawnSpy.mock.calls[0]?.[3] as
    | { bypassPermissions?: boolean; sideSession?: boolean }
    | undefined;
}
