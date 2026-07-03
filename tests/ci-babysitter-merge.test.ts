import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { healingAttempts, healingSessions } from "@/lib/db/schema";
import type { PrCheck } from "@/lib/github/gh";
import { GhClient } from "@/lib/github/gh";
import { ciBabysitter } from "@/lib/orchestrator/ci-babysitter";
import { activeHealingRunCount } from "@/lib/orchestrator/ci-healing";
import { HEALING_TERMINAL_STATES } from "@/lib/orchestrator/ci-healing-state";
import { createJob, getJob, transitionJob } from "@/lib/orchestrator/jobs";
import { addRepo } from "@/lib/repos/service";

let db: DB;
let repoId: number;
beforeEach(() => {
  db = createDb(":memory:");
  repoId = addRepo({ path: "/tmp/r", name: "r" }, db).id;
});

type MergeStateJson = { mergeable?: string; mergeStateStatus?: string };

interface ScriptOptions {
  checks: PrCheck[][];
  /** Non-zero → `mergePr` throws a GhError with `mergeStderr`. */
  mergeExit?: number;
  mergeStderr?: string;
  /** One `prMergeState` JSON per merge attempt (last repeats). */
  mergeState?: MergeStateJson[];
  /** Failed-step log served for the auto-heal fix prompt. */
  failedLog?: string;
}

/**
 * GhClient whose `mergePr`, `prMergeState`, and `updatePrBranch` are all
 * scriptable, so the merge-failure paths (issue #386) can be exercised.
 */
function scriptedGh(opts: ScriptOptions) {
  let checkI = 0;
  let stateI = 0;
  const runner = vi.fn(async (_cmd: string, args: string[]) => {
    if (args[0] === "pr" && args[1] === "checks") {
      const checks = opts.checks[Math.min(checkI, opts.checks.length - 1)] ?? [];
      checkI++;
      return { stdout: JSON.stringify(checks), stderr: "", exitCode: 0 };
    }
    // prMergeState: `pr view N --json mergeable,mergeStateStatus` (the fields
    // are a single comma-joined arg element, not separate tokens).
    if (args[0] === "pr" && args[1] === "view" && args.some((a) => a.includes("mergeable"))) {
      const seq = opts.mergeState ?? [{ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }];
      const json = seq[Math.min(stateI, seq.length - 1)] ?? {};
      stateI++;
      return { stdout: JSON.stringify(json), stderr: "", exitCode: 0 };
    }
    if (args[0] === "pr" && args[1] === "update-branch") {
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    // failedRunLog chain: pr head branch → newest failed run → failed-step log.
    if (args[0] === "pr" && args[1] === "view" && args.includes("headRefName")) {
      return { stdout: JSON.stringify({ headRefName: "feature" }), stderr: "", exitCode: 0 };
    }
    if (args[0] === "run" && args[1] === "list") {
      return {
        stdout: JSON.stringify([{ databaseId: 1, conclusion: "failure" }]),
        stderr: "",
        exitCode: 0,
      };
    }
    if (args[0] === "pr" && args[1] === "merge") {
      const exitCode = opts.mergeExit ?? 0;
      return {
        stdout: "",
        stderr: exitCode === 0 ? "" : (opts.mergeStderr ?? "merge failed"),
        exitCode,
      };
    }
    if (args[0] === "issue" && args[1] === "create") {
      return { stdout: "https://github.com/o/r/issues/99\n", stderr: "", exitCode: 0 };
    }
    if (args.includes("--log-failed"))
      return { stdout: opts.failedLog ?? "log", stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "", exitCode: 0 };
  });
  return { gh: new GhClient("/tmp/r", runner), runner };
}

function ciRunningJob(issue: number) {
  const job = createJob({ repoId, issueNumber: issue, model: "claude-sonnet-4-5" }, db);
  transitionJob(job.id, "working", {}, db);
  return transitionJob(job.id, "ci_running", { prNumber: 5, sessionId: "sess-1" }, db);
}

const mergeArgs = expect.arrayContaining(["pr", "merge", "5"]);

describe("ciBabysitter — merge failure paths (issue #386)", () => {
  it("parks needs_human with an actionable message when the merge throws", async () => {
    const job = ciRunningJob(1);
    const { gh } = scriptedGh({
      checks: [[{ name: "build", state: "SUCCESS" }]],
      mergeExit: 1,
      mergeStderr: "GraphQL: Pull request is not mergeable (enablePullRequestAutoMerge)",
    });
    const final = await ciBabysitter(job, 5, {
      db,
      gh,
      resumeSession: vi.fn(),
      sleep: vi.fn(),
      maxPolls: 3,
    });
    expect(final.status).toBe("needs_human");
    // Actionable framing, not a bare stderr dump: names the PR and the failure.
    expect(final.errorMessage).toMatch(/could not be merged/i);
    expect(final.errorMessage).toContain("#5");
    expect(getJob(job.id, db)?.status).toBe("needs_human");
  });

  it("escalates instead of merging a conflicted PR", async () => {
    const job = ciRunningJob(2);
    const { gh, runner } = scriptedGh({
      checks: [[{ name: "build", state: "SUCCESS" }]],
      mergeState: [{ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }],
    });
    const final = await ciBabysitter(job, 5, {
      db,
      gh,
      resumeSession: vi.fn(),
      sleep: vi.fn(),
      maxPolls: 3,
    });
    expect(final.status).toBe("needs_human");
    expect(final.errorMessage).toMatch(/conflict/i);
    // Never merge a conflicted PR blind.
    expect(runner).not.toHaveBeenCalledWith("gh", mergeArgs, "/tmp/r");
  });

  it("updates a behind branch and re-polls instead of merging blind", async () => {
    const job = ciRunningJob(3);
    const { gh, runner } = scriptedGh({
      checks: [[{ name: "build", state: "SUCCESS" }], [{ name: "build", state: "SUCCESS" }]],
      // Behind on the first attempt (strict checks would queue --auto forever),
      // clean on the second after the branch is updated.
      mergeState: [
        { mergeable: "MERGEABLE", mergeStateStatus: "BEHIND" },
        { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" },
      ],
    });
    const final = await ciBabysitter(job, 5, {
      db,
      gh,
      resumeSession: vi.fn(),
      sleep: vi.fn(),
      maxPolls: 5,
    });
    expect(final.status).toBe("merged");
    // The behind branch is updated first, then merged once clean.
    expect(runner).toHaveBeenCalledWith(
      "gh",
      expect.arrayContaining(["pr", "update-branch", "5"]),
      "/tmp/r",
    );
    expect(runner).toHaveBeenCalledWith("gh", mergeArgs, "/tmp/r");
  });

  it("escalates a branch that never settles clean past the CI wait budget", async () => {
    const job = ciRunningJob(5);
    const { gh } = scriptedGh({
      checks: [[{ name: "build", state: "SUCCESS" }]],
      // Perpetually behind: --auto would queue forever, so the loop keeps
      // updating and re-polling until the wait budget is exhausted.
      mergeState: [{ mergeable: "MERGEABLE", mergeStateStatus: "BEHIND" }],
    });
    let t = 0;
    const sleep = vi.fn(async () => {
      t += 60_000;
    });
    const final = await ciBabysitter(job, 5, {
      db,
      gh,
      resumeSession: vi.fn(),
      sleep,
      now: () => t,
      ciWaitMs: 2 * 60_000,
      maxPolls: 1000,
    });
    expect(final.status).toBe("needs_human");
    expect(final.errorMessage).toMatch(/did not complete in time/i);
    expect(final.errorMessage).toMatch(/behind its base/i);
  });

  it("parks needs_human when a no-checks merge throws (issue #207 path)", async () => {
    const job = ciRunningJob(4);
    const { gh } = scriptedGh({
      checks: [[]],
      mergeExit: 1,
      mergeStderr: "auto-merge is not allowed for this repository",
    });
    let t = 0;
    const sleep = vi.fn(async () => {
      t += 2 * 60_000;
    });
    const final = await ciBabysitter(job, 5, {
      db,
      gh,
      resumeSession: vi.fn(),
      sleep,
      now: () => t,
      mergeWithoutChecks: true,
      mergeGateMs: 5 * 60_000,
      ciWaitMs: 60 * 60_000,
      maxPolls: 1000,
    });
    expect(final.status).toBe("needs_human");
    expect(final.errorMessage).toMatch(/could not be merged/i);
  });
});

const HEAL_LOG = "FAIL tests/foo.test.ts > x";

describe("ciBabysitter auto-heal — merge failure paths (issue #386)", () => {
  it("leaves the healing session terminal when the merge throws after a heal", async () => {
    const job = ciRunningJob(10);
    const { gh } = scriptedGh({
      checks: [
        [{ name: "test", state: "FAILURE" }], // poll 1: heal
        [{ name: "test", state: "SUCCESS" }], // poll 2: green → merge throws
      ],
      failedLog: HEAL_LOG,
      mergeExit: 1,
      mergeStderr: "auto-merge is not allowed for this repository",
    });
    const resume = vi.fn(async () => ({ exitCode: 0 }));
    const headSha = vi.fn().mockResolvedValueOnce("sha-1").mockResolvedValue("sha-2");
    const final = await ciBabysitter(job, 5, {
      db,
      gh,
      resumeSession: resume,
      sleep: vi.fn(),
      maxPolls: 12,
      pollMs: 1,
      autoHeal: { headSha, provider: "github" },
    });
    expect(final.status).toBe("needs_human");
    expect(final.errorMessage).toMatch(/could not be merged/i);
    // The heal itself succeeded (CI went green): the attempt/session are healed,
    // a terminal state — not stranded in an in-flight slot.
    const session = db.select().from(healingSessions).all()[0];
    expect(HEALING_TERMINAL_STATES).toContain(session?.status);
    expect(db.select().from(healingAttempts).all()[0]?.status).toBe("healed");
    // No in-flight healing slot leaked past the failed merge.
    expect(activeHealingRunCount(db)).toBe(0);
  });

  it("escalates a conflicted PR after a heal without leaking a slot", async () => {
    const job = ciRunningJob(11);
    const { gh, runner } = scriptedGh({
      checks: [[{ name: "test", state: "FAILURE" }], [{ name: "test", state: "SUCCESS" }]],
      failedLog: HEAL_LOG,
      mergeState: [{ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }],
    });
    const resume = vi.fn(async () => ({ exitCode: 0 }));
    const headSha = vi.fn().mockResolvedValueOnce("sha-1").mockResolvedValue("sha-2");
    const final = await ciBabysitter(job, 5, {
      db,
      gh,
      resumeSession: resume,
      sleep: vi.fn(),
      maxPolls: 12,
      pollMs: 1,
      autoHeal: { headSha, provider: "github" },
    });
    expect(final.status).toBe("needs_human");
    expect(final.errorMessage).toMatch(/conflict/i);
    expect(runner).not.toHaveBeenCalledWith("gh", mergeArgs, "/tmp/r");
    expect(activeHealingRunCount(db)).toBe(0);
  });
});
