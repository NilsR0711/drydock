import { beforeEach, describe, expect, it, vi } from "vitest";
import { codexProvider } from "@/lib/agents/codex";
import type { AgentProvider } from "@/lib/agents/types";
import { createDb, type DB } from "@/lib/db/client";
import type { Job, Repo } from "@/lib/db/schema";
import type { StreamCallbacks, StreamHandle, StreamRunner } from "@/lib/exec/stream-runner";
import type { ForgeClient, ReviewThread } from "@/lib/forge/types";
import type { Worktree } from "@/lib/git/worktree";
import { syncIssuesFromGh } from "@/lib/issues/service";
import { createJob, getJob, transitionJob } from "@/lib/orchestrator/jobs";
import { addRepo } from "@/lib/repos/service";
import { saveSettings } from "@/lib/settings/service";
import { LogBroker } from "@/lib/stream/broker";
import { StreamJsonParser } from "@/lib/stream/parser";

// `defaultProcessJob` persists via the process-wide getDb() singleton, not the
// db handed to driveReviewFeedback. Point getDb() at the test's in-memory DB so
// the job created here and the feedback item written there share one database
// (otherwise the item insert trips the jobId foreign key).
const dbHolder = vi.hoisted(() => ({ current: undefined as DB | undefined }));
vi.mock("@/lib/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/client")>();
  return { ...actual, getDb: () => dbHolder.current as DB };
});

// Delegating spawn mock: it records the deps the driver forwarded (so a test can
// assert the *resolved* bounds), then runs the REAL bounding logic against an
// injectable runner/provider. This lets one seam prove both that the driver
// passes timeoutMs/costCapUsd AND that those bounds actually abort a hung side
// session — the exact wedge issue #383 is about.
//
// The state lives in a hoisted holder, not an imported binding: the driver imports
// `./agent-session` (relative) while this file imports the `@/`-aliased path, and
// Vitest resolves those to distinct module records — an imported binding would
// observe zero calls even though the driver hit the mock.
const spawnState = vi.hoisted(() => ({
  calls: [] as unknown[][],
  runner: undefined as unknown,
  provider: undefined as unknown,
  timeoutOverrideMs: undefined as number | undefined,
  broker: undefined as unknown,
}));
vi.mock("@/lib/orchestrator/agent-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/orchestrator/agent-session")>();
  return {
    ...actual,
    spawnAgentSession: (
      job: unknown,
      prompt: unknown,
      cwd: unknown,
      deps: Record<string, unknown>,
    ) => {
      spawnState.calls.push([job, prompt, cwd, deps]);
      return actual.spawnAgentSession(job as never, prompt as string, cwd as string, {
        ...deps,
        ...(spawnState.runner ? { runner: spawnState.runner as StreamRunner } : {}),
        ...(spawnState.provider ? { provider: spawnState.provider as AgentProvider } : {}),
        ...(spawnState.timeoutOverrideMs != null
          ? { timeoutMs: spawnState.timeoutOverrideMs }
          : {}),
        ...(spawnState.broker ? { broker: spawnState.broker as LogBroker } : {}),
        // Keep the drain window tiny so an aborted hung runner finalises fast.
        graceMs: 5,
      });
    },
  };
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
  spawnState.calls.length = 0;
  spawnState.runner = undefined;
  spawnState.provider = undefined;
  spawnState.timeoutOverrideMs = undefined;
  spawnState.broker = new LogBroker(db);
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

/** A job that has reached a PR (prNumber + branch set), eligible for the sweep. */
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

/** A runner that exits immediately with no output — reaches spawn without work. */
const immediateRunner: StreamRunner = (_cmd, _args, _cwd, cb: StreamCallbacks): StreamHandle => {
  cb.onStdout("");
  return { done: Promise.resolve(0), abort: () => {} };
};

/** The spawn options (4th positional arg) from the single recorded spawn call. */
function spawnDeps():
  | { timeoutMs?: number; costCapUsd?: number; sideSession?: boolean }
  | undefined {
  return spawnState.calls[0]?.[3] as
    | { timeoutMs?: number; costCapUsd?: number; sideSession?: boolean }
    | undefined;
}

describe("review-feedback side session — wall-clock/cost bounds (issue #383)", () => {
  it("forwards the global default timeout and cost cap to the side session", async () => {
    spawnState.runner = immediateRunner;
    const repo = addRepo({ path: "/r", name: "r", trustedReviewers: ["alice"] }, db);
    jobWithPr(repo, 1, 5);

    await driveReviewFeedback({ db, forgeFor: () => reviewForge() });

    expect(spawnState.calls).toHaveLength(1);
    // Global defaults: maxJobMinutes 120 → 7_200_000ms; maxJobCostUsd 0 (off).
    expect(spawnDeps()?.timeoutMs).toBe(120 * 60_000);
    expect(spawnDeps()?.costCapUsd).toBe(0);
    // Must stay a side session: a normal spawn would throw an invalid transition.
    expect(spawnDeps()?.sideSession).toBe(true);
  });

  it("prefers per-repo overrides over the global settings", async () => {
    spawnState.runner = immediateRunner;
    saveSettings({ maxJobMinutes: 120, maxJobCostUsd: 9 }, db);
    const repo = addRepo(
      { path: "/r", name: "r", trustedReviewers: ["alice"], maxJobMinutes: 3, maxJobCostUsd: 1.5 },
      db,
    );
    jobWithPr(repo, 1, 5);

    await driveReviewFeedback({ db, forgeFor: () => reviewForge() });

    expect(spawnDeps()?.timeoutMs).toBe(3 * 60_000);
    expect(spawnDeps()?.costCapUsd).toBe(1.5);
  });

  it("aborts a hung side session when the timeout elapses and the sweep resolves", async () => {
    let aborted = false;
    let resolveDone: (code: number) => void = () => {};
    const done = new Promise<number>((res) => {
      resolveDone = res;
    });
    // Never resolves on its own: only the wall-clock timeout can end it.
    spawnState.runner = (() => ({
      done,
      abort: () => {
        aborted = true;
        resolveDone(0);
      },
    })) as StreamRunner;
    // Compress the real forwarded timeout so the test is fast; the forwarded
    // value itself is still asserted below.
    spawnState.timeoutOverrideMs = 20;

    const repo = addRepo({ path: "/r", name: "r", trustedReviewers: ["alice"] }, db);
    jobWithPr(repo, 1, 5);

    // If the bounds were not forwarded, awaitBounded short-circuits to the bare
    // handle.done and this await would hang forever (the wedge in #383).
    await driveReviewFeedback({ db, forgeFor: () => reviewForge() });

    expect(aborted).toBe(true);
    // The driver still forwarded the real resolved bound (120 min), independent
    // of the compression applied for test speed.
    expect(spawnDeps()?.timeoutMs).toBe(120 * 60_000);
  });

  it("trips the cost guard for a side session that exceeds the per-job cap", async () => {
    // Prices output tokens at a flat $0.001 each and parses the claude stream so
    // the cost guard's live estimate is deterministic.
    const pricedProvider: AgentProvider = {
      ...codexProvider,
      createParser: () => new StreamJsonParser(),
      estimateCost: (_m, _in, out) => out * 0.001,
    };
    const assistantUsage = (outputTokens: number): string =>
      `${JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "working" }],
          usage: { output_tokens: outputTokens },
        },
      })}\n`;

    let aborted = false;
    spawnState.provider = pricedProvider;
    spawnState.runner = ((_cmd, _args, _cwd, cb: StreamCallbacks) => {
      cb.onStdout(assistantUsage(1000)); // 1000 tok → $1.00, over the $0.50 cap
      let resolveDone: (code: number) => void = () => {};
      const done = new Promise<number>((res) => {
        resolveDone = res;
      });
      return {
        done,
        abort: () => {
          aborted = true;
          resolveDone(0);
        },
      };
    }) as StreamRunner;

    const repo = addRepo(
      { path: "/r", name: "r", trustedReviewers: ["alice"], maxJobCostUsd: 0.5 },
      db,
    );
    const job = jobWithPr(repo, 1, 5);

    await driveReviewFeedback({ db, forgeFor: () => reviewForge() });

    expect(spawnDeps()?.costCapUsd).toBe(0.5);
    expect(aborted).toBe(true);
    // The partial spend of the aborted side session is billed to the job.
    expect(getJob(job.id, db)?.costUsd).toBeGreaterThan(0);
  });
});
