import { eq } from "drizzle-orm";
import { vi } from "vitest";
import type { DB } from "@/lib/db/client";
import { type Job, jobs } from "@/lib/db/schema";
import type { AgentSessionResult } from "@/lib/orchestrator/agent-session";
import { getJob } from "@/lib/orchestrator/jobs";
import type { RunJobDeps } from "@/lib/orchestrator/run-job";

/**
 * The injectable worktree seam of {@link RunJobDeps}, made non-optional so a
 * fixture can be checked against the full interface at compile time (issue
 * #385). Previously the unit suites cast their partial dep bundles with
 * `as never`, which silenced even the stub-signature check the interface is
 * meant to enforce.
 */
export type FakeWorktreeApi = NonNullable<RunJobDeps["worktrees"]>;

/**
 * A complete, typed WorktreeApi fake: every seam runJob may reach is stubbed,
 * so the object satisfies the interface without an `as never` escape hatch. The
 * `removed` sentinel lets a test assert the worktree was cleaned up.
 */
export function fakeWorktrees(removed: { v: boolean }): FakeWorktreeApi {
  const wt = { path: "/wt", branch: "drydock/issue-1-job-1" };
  return {
    prepare: vi.fn(async () => wt),
    prepareResume: vi.fn(async () => wt),
    commitAndPush: vi.fn(async () => {}),
    commitAndPushForHuman: vi.fn(async () => false),
    headSha: vi.fn(async () => "headsha"),
    remove: vi.fn(async () => {
      removed.v = true;
    }),
  };
}

/**
 * Fill an {@link AgentSessionResult} with successful-run defaults so a test only
 * spells out the fields it exercises (e.g. `{ exitCode: 1 }`) while the object
 * still satisfies the full type — the required `timedOut`/`costExceeded`/
 * `maxTurnsReached` flags no longer have to be repeated at every call site.
 */
export function sessionResult(over: Partial<AgentSessionResult> = {}): AgentSessionResult {
  return {
    exitCode: 0,
    sessionId: "s1",
    costUsd: 0.1,
    inputTokens: 1,
    outputTokens: 1,
    timedOut: false,
    costExceeded: false,
    maxTurnsReached: false,
    ...over,
  };
}

/**
 * A {@link RunJobDeps} bundle whose stubs the unit suites assert against are
 * guaranteed present (not the optional shape of RunJobDeps), so tests can read
 * `deps.worktrees.prepare` / `deps.createPr` without a non-null assertion.
 */
export interface BaseRunJobDeps extends RunJobDeps {
  db: DB;
  worktrees: FakeWorktreeApi;
  runSession: NonNullable<RunJobDeps["runSession"]>;
  createPr: NonNullable<RunJobDeps["createPr"]>;
  runBabysitter: NonNullable<RunJobDeps["runBabysitter"]>;
}

/**
 * The default runJob dependency bundle for the unit suites: a fully faked
 * worktree, a session that succeeds, a forge that opens PR #55, and a babysitter
 * that merges. `over` replaces any field to exercise a specific branch. Typed
 * against {@link RunJobDeps} so the stubs are compile-checked (issue #385).
 */
export function baseRunJobDeps(
  db: DB,
  removed: { v: boolean },
  over: Partial<RunJobDeps> = {},
): BaseRunJobDeps {
  return {
    db,
    worktrees: fakeWorktrees(removed),
    runSession: vi.fn(async (job: Job) => {
      db.update(jobs).set({ status: "working", sessionId: "s1" }).where(eq(jobs.id, job.id)).run();
      return sessionResult();
    }),
    createPr: vi.fn(async () => 55),
    viewIssue: vi.fn(async () => ({ title: "", body: "" })),
    runBabysitter: vi.fn(async (job: Job) => {
      db.update(jobs).set({ status: "merged" }).where(eq(jobs.id, job.id)).run();
      return getJob(job.id, db) as Job;
    }),
    announceNeedsHuman: vi.fn(async () => {}),
    // Post-PR verification and AI PR audit default on now (issue #254); the core
    // lifecycle suites stub both best-effort passes to no-ops instead of letting
    // them spawn a real `gh`.
    verify: vi.fn(async () => {}),
    audit: vi.fn(async () => null),
    ...over,
  };
}
