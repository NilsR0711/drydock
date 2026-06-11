import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { followupIssues } from "@/lib/db/schema";
import type { PrCheck } from "@/lib/github/gh";
import { GhClient } from "@/lib/github/gh";
import { ciBabysitter, classifyChecks } from "@/lib/orchestrator/ci-babysitter";
import { DEFAULT_EVIDENCE_LINES } from "@/lib/orchestrator/ci-fix-prompt";
import { buildResumeArgs } from "@/lib/orchestrator/claude-session";
import { createJob, getJob, transitionJob } from "@/lib/orchestrator/jobs";
import { addRepo } from "@/lib/repos/service";

let db: DB;
let repoId: number;
beforeEach(() => {
  db = createDb(":memory:");
  repoId = addRepo({ path: "/tmp/r", name: "r" }, db).id;
});

/** GhClient backed by a runner that returns scripted JSON per `gh` subcommand. */
function scriptedGh(checkSequence: PrCheck[][]) {
  let i = 0;
  const runner = vi.fn(async (_cmd: string, args: string[]) => {
    if (args[0] === "pr" && args[1] === "checks") {
      const checks = checkSequence[Math.min(i, checkSequence.length - 1)] ?? [];
      i++;
      return { stdout: JSON.stringify(checks), stderr: "", exitCode: checks.length ? 0 : 0 };
    }
    if (args.includes("--log-failed"))
      return { stdout: "build error log", stderr: "", exitCode: 0 };
    if (args[0] === "issue" && args[1] === "create")
      return { stdout: "https://github.com/o/r/issues/99\n", stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "", exitCode: 0 };
  });
  return { gh: new GhClient("/tmp/r", runner), runner };
}

function ciRunningJob(issue: number) {
  const job = createJob({ repoId, issueNumber: issue, model: "claude-sonnet-4-5" }, db);
  transitionJob(job.id, "working", {}, db);
  return transitionJob(job.id, "ci_running", { prNumber: 5, sessionId: "sess-1" }, db);
}

describe("classifyChecks", () => {
  it("returns pending for empty or in-progress", () => {
    expect(classifyChecks([])).toBe("pending");
    expect(classifyChecks([{ name: "a", state: "IN_PROGRESS" }])).toBe("pending");
  });
  it("returns failed when any check failed", () => {
    expect(
      classifyChecks([
        { name: "a", state: "SUCCESS" },
        { name: "b", state: "FAILURE" },
      ]),
    ).toBe("failed");
  });
  it("returns passed when all succeed", () => {
    expect(classifyChecks([{ name: "a", state: "SUCCESS" }])).toBe("passed");
  });
});

describe("buildResumeArgs", () => {
  it("uses --resume with Haiku and 15 turns", () => {
    const args = buildResumeArgs("CI failed: fix it", "sess-1");
    expect(args).toEqual(
      expect.arrayContaining([
        "--resume",
        "sess-1",
        "--model",
        "claude-haiku-4-5",
        "--max-turns",
        "15",
      ]),
    );
  });
});

describe("ciBabysitter", () => {
  it("merges when checks pass", async () => {
    const job = ciRunningJob(1);
    const { gh, runner } = scriptedGh([[{ name: "build", state: "SUCCESS" }]]);
    const final = await ciBabysitter(job, 5, {
      db,
      gh,
      resumeSession: vi.fn(),
      sleep: vi.fn(),
      maxPolls: 3,
    });
    expect(final.status).toBe("merged");
    expect(runner).toHaveBeenCalledWith(
      "gh",
      expect.arrayContaining(["pr", "merge", "5"]),
      "/tmp/r",
    );
  });

  it("never merges a job that was aborted while babysitting", async () => {
    const job = ciRunningJob(6);
    // An abort (abort action, emergency stop) only flips the DB row — the
    // polling loop must observe it instead of merging the aborted job's PR.
    transitionJob(job.id, "aborted", {}, db);
    const { gh, runner } = scriptedGh([[{ name: "build", state: "SUCCESS" }]]);
    const final = await ciBabysitter(job, 5, {
      db,
      gh,
      resumeSession: vi.fn(),
      sleep: vi.fn(),
      maxPolls: 3,
    });
    expect(final.status).toBe("aborted");
    expect(runner).not.toHaveBeenCalledWith(
      "gh",
      expect.arrayContaining(["pr", "merge", "5"]),
      "/tmp/r",
    );
  });

  it("retries on failure then merges on the next green poll", async () => {
    const job = ciRunningJob(2);
    const { gh } = scriptedGh([
      [{ name: "build", state: "FAILURE" }],
      [{ name: "build", state: "SUCCESS" }],
    ]);
    const resume = vi.fn(async () => ({ exitCode: 0 }));
    const final = await ciBabysitter(job, 5, {
      db,
      gh,
      resumeSession: resume,
      sleep: vi.fn(),
      maxPolls: 5,
    });
    expect(resume).toHaveBeenCalledOnce();
    expect(final.status).toBe("merged");
    expect(getJob(job.id, db)?.ciRetryCount).toBe(1);
  });

  it("hands over to a human when the job has no session id to resume", async () => {
    // ci_running job without a recorded session id.
    const job = createJob({ repoId, issueNumber: 4, model: "claude-sonnet-4-5" }, db);
    transitionJob(job.id, "working", {}, db);
    transitionJob(job.id, "ci_running", { prNumber: 5 }, db);
    const { gh } = scriptedGh([[{ name: "build", state: "FAILURE" }]]);
    const resume = vi.fn(async () => ({ exitCode: 0 }));
    const final = await ciBabysitter(job, 5, {
      db,
      gh,
      resumeSession: resume,
      sleep: vi.fn(),
      maxPolls: 10,
    });
    expect(final.status).toBe("needs_human");
    expect(resume).not.toHaveBeenCalled();
    expect(getJob(job.id, db)?.errorMessage).toContain("no session id");
  });

  it("escalates to needs_human when checks stay pending past the wait budget", async () => {
    const job = ciRunningJob(6);
    const { gh } = scriptedGh([[{ name: "build", state: "PENDING" }]]);
    const resume = vi.fn(async () => ({ exitCode: 0 }));
    // Clock advances 60s per call; budget is 2 min, so the deadline is breached
    // after a couple of pending polls rather than looping forever.
    let t = 0;
    const now = () => (t += 60_000);
    const final = await ciBabysitter(job, 5, {
      db,
      gh,
      resumeSession: resume,
      sleep: vi.fn(),
      now,
      ciWaitMs: 2 * 60_000,
      maxPolls: 1000,
    });
    expect(final.status).toBe("needs_human");
    expect(resume).not.toHaveBeenCalled();
    expect(final.errorMessage).toContain("CI did not complete in time");
  });

  it("merges within the wait budget when a pending check turns green", async () => {
    const job = ciRunningJob(7);
    const { gh } = scriptedGh([
      [{ name: "build", state: "PENDING" }],
      [{ name: "build", state: "SUCCESS" }],
    ]);
    let t = 0;
    const now = () => (t += 60_000);
    const final = await ciBabysitter(job, 5, {
      db,
      gh,
      resumeSession: vi.fn(),
      sleep: vi.fn(),
      now,
      ciWaitMs: 60 * 60_000,
      maxPolls: 1000,
    });
    expect(final.status).toBe("merged");
  });

  it("feeds the resume session a line-capped, focused evidence slice", async () => {
    const job = ciRunningJob(8);
    // A large log whose only actionable line is a TS error buried in noise.
    const big = [
      ...Array.from({ length: 400 }, (_, i) => `::group::noise ${i}`),
      "src/a.ts(3,5): error TS2322: Type 'x' is not assignable to type 'number'.",
    ].join("\n");
    let i = 0;
    const runner = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "pr" && args[1] === "checks") {
        const seq: PrCheck[][] = [
          [{ name: "typecheck", state: "FAILURE" }],
          [{ name: "typecheck", state: "SUCCESS" }],
        ];
        const checks = seq[Math.min(i, seq.length - 1)] ?? [];
        i++;
        return { stdout: JSON.stringify(checks), stderr: "", exitCode: 0 };
      }
      if (args[0] === "pr" && args[1] === "view")
        return { stdout: JSON.stringify({ headRefName: "feature" }), stderr: "", exitCode: 0 };
      if (args[0] === "run" && args[1] === "list")
        return {
          stdout: JSON.stringify([{ databaseId: 1, conclusion: "failure" }]),
          stderr: "",
          exitCode: 0,
        };
      if (args.includes("--log-failed")) return { stdout: big, stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const gh = new GhClient("/tmp/r", runner);
    let captured = "";
    const resume = vi.fn(async (_j: unknown, _s: string, log: string) => {
      captured = log;
      return { exitCode: 0 };
    });
    const final = await ciBabysitter(job, 5, {
      db,
      gh,
      resumeSession: resume,
      sleep: vi.fn(),
      maxPolls: 5,
    });
    expect(final.status).toBe("merged");
    expect(resume).toHaveBeenCalledOnce();
    // Bounded by lines, not just the raw 8000-char tail.
    expect(captured.split("\n").length).toBeLessThanOrEqual(DEFAULT_EVIDENCE_LINES);
    // The focused, actionable line survives the extraction.
    expect(captured).toContain("error TS2322");
  });

  it("gives up after MAX retries -> needs_human + follow-up issue", async () => {
    const job = ciRunningJob(3);
    const { gh } = scriptedGh([[{ name: "build", state: "FAILURE" }]]);
    const resume = vi.fn(async () => ({ exitCode: 0 }));
    const final = await ciBabysitter(job, 5, {
      db,
      gh,
      resumeSession: resume,
      sleep: vi.fn(),
      maxPolls: 10,
    });
    expect(final.status).toBe("needs_human");
    expect(resume).toHaveBeenCalledTimes(3);
    expect(db.select().from(followupIssues).all()).toHaveLength(1);
  });
});

describe("ciBabysitter — merge gate (issue #159)", () => {
  it("holds the merge for the settle window, then merges", async () => {
    const job = ciRunningJob(20);
    const { gh, runner } = scriptedGh([[{ name: "build", state: "SUCCESS" }]]);
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
      mergeGateMs: 5 * 60_000,
      maxPolls: 1000,
    });
    expect(final.status).toBe("merged");
    // Three gated polls (at 0, 2, and 4 min) before the 5-minute window elapses.
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(runner).toHaveBeenCalledWith(
      "gh",
      expect.arrayContaining(["pr", "merge", "5"]),
      "/tmp/r",
    );
  });

  it("resets the settle window when checks regress to pending", async () => {
    const job = ciRunningJob(21);
    const { gh } = scriptedGh([
      [{ name: "build", state: "SUCCESS" }],
      [{ name: "build", state: "PENDING" }],
      [{ name: "build", state: "SUCCESS" }],
    ]);
    let t = 0;
    const sleep = vi.fn(async () => {
      t += 3 * 60_000;
    });
    const final = await ciBabysitter(job, 5, {
      db,
      gh,
      resumeSession: vi.fn(),
      sleep,
      now: () => t,
      mergeGateMs: 5 * 60_000,
      ciWaitMs: 60 * 60_000,
      maxPolls: 1000,
    });
    expect(final.status).toBe("merged");
    // Without the reset, the third poll (6 min after the first green) would
    // merge straight away; the pending regression re-arms the window, costing
    // two more gated polls (4 sleeps total instead of 2).
    expect(sleep).toHaveBeenCalledTimes(4);
  });

  it("still runs the retry path when checks fail during the window", async () => {
    const job = ciRunningJob(22);
    const { gh } = scriptedGh([
      [{ name: "build", state: "SUCCESS" }],
      [{ name: "build", state: "FAILURE" }],
      [{ name: "build", state: "SUCCESS" }],
    ]);
    const resume = vi.fn(async () => ({ exitCode: 0 }));
    let t = 0;
    const sleep = vi.fn(async () => {
      t += 3 * 60_000;
    });
    const final = await ciBabysitter(job, 5, {
      db,
      gh,
      resumeSession: resume,
      sleep,
      now: () => t,
      mergeGateMs: 5 * 60_000,
      maxPolls: 1000,
    });
    expect(resume).toHaveBeenCalledOnce();
    expect(final.status).toBe("merged");
  });
});
