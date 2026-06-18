import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { followupIssues, healingAttempts, healingSessions } from "@/lib/db/schema";
import type { PrCheck } from "@/lib/github/gh";
import { GhClient } from "@/lib/github/gh";
import { ciBabysitter } from "@/lib/orchestrator/ci-babysitter";
import {
  activeHealingRunCount,
  DEFAULT_HEAL_BUDGETS,
  openHealingSession,
  transitionHealingSession,
} from "@/lib/orchestrator/ci-healing";
import { createJob, getJob, transitionJob } from "@/lib/orchestrator/jobs";
import { addRepo } from "@/lib/repos/service";

let db: DB;
let repoId: number;
beforeEach(() => {
  db = createDb(":memory:");
  repoId = addRepo({ path: "/tmp/r", name: "r", autoHealCi: true }, db).id;
});

/** GhClient backed by a scripted check sequence, with a failed-log per poll. */
function scriptedGh(checkSequence: PrCheck[][], failedLog = "FAIL tests/foo.test.ts > x") {
  let i = 0;
  const runner = vi.fn(async (_cmd: string, args: string[]) => {
    if (args[0] === "pr" && args[1] === "checks") {
      const checks = checkSequence[Math.min(i, checkSequence.length - 1)] ?? [];
      i++;
      return { stdout: JSON.stringify(checks), stderr: "", exitCode: 0 };
    }
    // failedRunLog chain: pr head branch → failed run → failed-step log.
    if (args[0] === "pr" && args[1] === "view")
      return { stdout: JSON.stringify({ headRefName: "feature" }), stderr: "", exitCode: 0 };
    if (args[0] === "run" && args[1] === "list")
      return {
        stdout: JSON.stringify([{ databaseId: 1, conclusion: "failure" }]),
        stderr: "",
        exitCode: 0,
      };
    if (args.includes("--log-failed") || args.includes("--log"))
      return { stdout: failedLog, stderr: "", exitCode: 0 };
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

const fast = { sleep: vi.fn(async () => {}), maxPolls: 12, pollMs: 1 };

describe("ciBabysitter auto-heal", () => {
  it("heals a healable failure: resumes the agent, then merges when green", async () => {
    const job = ciRunningJob(1);
    const { gh, runner } = scriptedGh([
      [{ name: "test", state: "FAILURE" }], // poll 1: failing → heal
      [{ name: "test", state: "SUCCESS" }], // poll 2: green → merged
    ]);
    const resume = vi.fn(async () => ({ exitCode: 0 }));
    // head SHA moves after the agent pushes a fix.
    const headSha = vi.fn().mockResolvedValueOnce("sha-1").mockResolvedValue("sha-2");
    const final = await ciBabysitter(job, 5, {
      db,
      gh,
      resumeSession: resume,
      ...fast,
      autoHeal: { headSha, provider: "github" },
    });
    expect(resume).toHaveBeenCalledOnce();
    expect(final.status).toBe("merged");
    expect(runner).toHaveBeenCalledWith(
      "gh",
      expect.arrayContaining(["pr", "merge", "5"]),
      "/tmp/r",
    );
    const attempts = db.select().from(healingAttempts).all();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe("healed");
    expect(db.select().from(healingSessions).all()[0]?.status).toBe("healed");
  });

  it("resumes with a category-specific, focused fix prompt for a test failure", async () => {
    const job = ciRunningJob(6);
    const { gh } = scriptedGh(
      [[{ name: "test", state: "FAILURE" }], [{ name: "test", state: "SUCCESS" }]],
      ["FAIL tests/foo.test.ts > does a thing", "AssertionError: expected 1 to be 2"].join("\n"),
    );
    let captured = "";
    const resume = vi.fn(async (_j: unknown, _s: string, prompt: string) => {
      captured = prompt;
      return { exitCode: 0 };
    });
    const headSha = vi.fn().mockResolvedValueOnce("sha-1").mockResolvedValue("sha-2");
    await ciBabysitter(job, 5, {
      db,
      gh,
      resumeSession: resume,
      ...fast,
      autoHeal: { headSha, provider: "github" },
    });
    expect(resume).toHaveBeenCalledOnce();
    // Names the failing check and carries test-specific guidance + evidence.
    expect(captured).toContain('"test"');
    expect(captured.toLowerCase()).toMatch(/do not (delete|skip)/);
    expect(captured).toContain("FAIL tests/foo.test.ts");
  });

  it("never code-heals a blocked_external failure — hands to a human, no resume", async () => {
    const job = ciRunningJob(2);
    const { gh } = scriptedGh([[{ name: "AI Review", state: "FAILURE" }]]);
    const resume = vi.fn(async () => ({ exitCode: 0 }));
    const final = await ciBabysitter(job, 5, {
      db,
      gh,
      resumeSession: resume,
      ...fast,
      autoHeal: { headSha: vi.fn().mockResolvedValue("sha-1"), provider: "github" },
    });
    expect(resume).not.toHaveBeenCalled();
    expect(final.status).toBe("needs_human");
    expect(db.select().from(healingSessions).all()[0]?.status).toBe("blocked");
    expect(db.select().from(healingAttempts).all()).toHaveLength(0);
  });

  it("rejects an empty heal (no new commit) and escalates", async () => {
    const job = ciRunningJob(3);
    const { gh } = scriptedGh([
      [{ name: "test", state: "FAILURE" }], // poll 1: heal attempt
      [{ name: "test", state: "FAILURE" }], // poll 2: still failing, head unchanged
    ]);
    const resume = vi.fn(async () => ({ exitCode: 0 }));
    const final = await ciBabysitter(job, 5, {
      db,
      gh,
      resumeSession: resume,
      ...fast,
      autoHeal: { headSha: vi.fn().mockResolvedValue("sha-1"), provider: "github" },
    });
    expect(final.status).toBe("needs_human");
    const attempts = db.select().from(healingAttempts).all();
    expect(attempts[0]?.status).toBe("rejected");
    expect(db.select().from(healingSessions).all()[0]?.status).toBe("escalated");
    expect(db.select().from(followupIssues).all()).toHaveLength(1);
  });

  it("escalates to needs_human when checks stay pending past the wait budget", async () => {
    const job = ciRunningJob(5);
    const { gh } = scriptedGh(Array(12).fill([{ name: "test", state: "PENDING" }]));
    const resume = vi.fn(async () => ({ exitCode: 0 }));
    let t = 0;
    const now = () => (t += 60_000);
    const final = await ciBabysitter(job, 5, {
      db,
      gh,
      resumeSession: resume,
      ...fast,
      now,
      ciWaitMs: 2 * 60_000,
      autoHeal: { headSha: vi.fn().mockResolvedValue("sha-1"), provider: "github", now },
    });
    expect(final.status).toBe("needs_human");
    expect(resume).not.toHaveBeenCalled();
    expect(getJob(job.id, db)?.errorMessage).toContain("CI did not complete in time");
  });

  it("re-runs a flaky check on the forge (no agent) and merges when it goes green", async () => {
    const job = ciRunningJob(7);
    const { gh, runner } = scriptedGh([
      [{ name: "e2e", state: "TIMED_OUT" }], // poll 1: flaky → forge re-run
      [{ name: "e2e", state: "SUCCESS" }], // poll 2: green → merged
    ]);
    const resume = vi.fn(async () => ({ exitCode: 0 }));
    // A re-run pushes no commit, so the head SHA never moves.
    const headSha = vi.fn().mockResolvedValue("sha-1");
    const final = await ciBabysitter(job, 5, {
      db,
      gh,
      resumeSession: resume,
      ...fast,
      autoHeal: { headSha, provider: "github" },
    });
    expect(final.status).toBe("merged");
    expect(resume).not.toHaveBeenCalled(); // a re-run never runs the agent
    expect(runner).toHaveBeenCalledWith("gh", ["run", "rerun", "1", "--failed"], "/tmp/r");
    const attempts = db.select().from(healingAttempts).all();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe("healed");
    expect(db.select().from(healingSessions).all()[0]?.status).toBe("healed");
  });

  it("escalates when the re-run leaves the flaky check failing", async () => {
    const job = ciRunningJob(8);
    const { gh } = scriptedGh([
      [{ name: "e2e", state: "TIMED_OUT" }], // poll 1: flaky → forge re-run
      [{ name: "e2e", state: "TIMED_OUT" }], // poll 2: still failing → escalate
    ]);
    const resume = vi.fn(async () => ({ exitCode: 0 }));
    const final = await ciBabysitter(job, 5, {
      db,
      gh,
      resumeSession: resume,
      ...fast,
      autoHeal: { headSha: vi.fn().mockResolvedValue("sha-1"), provider: "github" },
    });
    expect(final.status).toBe("needs_human");
    expect(resume).not.toHaveBeenCalled();
    expect(getJob(job.id, db)?.errorMessage).toContain("re-run did not clear");
    const attempts = db.select().from(healingAttempts).all();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe("rejected");
    expect(db.select().from(healingSessions).all()[0]?.status).toBe("escalated");
  });

  it("escalates without burning an attempt when the forge cannot re-run", async () => {
    const job = ciRunningJob(9);
    const { gh, runner } = scriptedGh([[{ name: "e2e", state: "TIMED_OUT" }]]);
    // Simulate a forge without re-run support (e.g. GitLab).
    (gh as { reRunFailedChecks?: unknown }).reRunFailedChecks = undefined;
    const resume = vi.fn(async () => ({ exitCode: 0 }));
    const final = await ciBabysitter(job, 5, {
      db,
      gh,
      resumeSession: resume,
      ...fast,
      autoHeal: { headSha: vi.fn().mockResolvedValue("sha-1"), provider: "github" },
    });
    expect(final.status).toBe("needs_human");
    expect(resume).not.toHaveBeenCalled();
    expect(getJob(job.id, db)?.errorMessage).toContain("manual re-run");
    expect(db.select().from(healingAttempts).all()).toHaveLength(0); // no attempt burned
    expect(db.select().from(healingSessions).all()[0]?.status).toBe("escalated");
    expect(db.select().from(followupIssues).all()).toHaveLength(1);
    expect(runner.mock.calls.some(([, args]) => args[1] === "rerun")).toBe(false);
  });

  it("escalates without burning an attempt when the forge re-run is not triggered", async () => {
    const job = ciRunningJob(10);
    const { gh } = scriptedGh([[{ name: "e2e", state: "TIMED_OUT" }]]);
    gh.reRunFailedChecks = vi.fn(async () => false);
    const final = await ciBabysitter(job, 5, {
      db,
      gh,
      resumeSession: vi.fn(async () => ({ exitCode: 0 })),
      ...fast,
      autoHeal: { headSha: vi.fn().mockResolvedValue("sha-1"), provider: "github" },
    });
    expect(final.status).toBe("needs_human");
    expect(db.select().from(healingAttempts).all()).toHaveLength(0);
    expect(db.select().from(healingSessions).all()[0]?.status).toBe("escalated");
  });

  it("closes a progressed session before opening the next one (no leaked slot)", async () => {
    const job = ciRunningJob(11);
    const { gh } = scriptedGh([
      [
        { name: "test", state: "FAILURE" },
        { name: "lint", state: "FAILURE" },
      ], // poll 1: two failures → repair "test"
      [{ name: "lint", state: "FAILURE" }], // poll 2: progressed → repair "lint"
      [{ name: "lint", state: "SUCCESS" }], // poll 3: green → merged
    ]);
    const resume = vi.fn(async () => ({ exitCode: 0 }));
    const headSha = vi
      .fn()
      .mockResolvedValueOnce("sha-1")
      .mockResolvedValueOnce("sha-2")
      .mockResolvedValue("sha-3");
    const final = await ciBabysitter(job, 5, {
      db,
      gh,
      resumeSession: resume,
      ...fast,
      autoHeal: { headSha, provider: "github" },
    });
    expect(final.status).toBe("merged");
    expect(resume).toHaveBeenCalledTimes(2);
    const sessions = db.select().from(healingSessions).all();
    expect(sessions).toHaveLength(2);
    // The progressed session must not linger in awaiting_ci: it would occupy
    // an in-flight healing slot forever and block all future healing.
    expect(sessions.find((s) => s.headSha === "sha-1")?.status).toBe("superseded");
    expect(sessions.find((s) => s.headSha === "sha-2")?.status).toBe("healed");
    expect(activeHealingRunCount(db)).toBe(0);
    const attempts = db.select().from(healingAttempts).all();
    expect(attempts.map((a) => a.status)).toEqual(["progressed", "healed"]);
  });

  it("recovers from a stale mid-flight session for the same head SHA (no crash)", async () => {
    const job = ciRunningJob(12);
    // A previous loop crashed and left a session for sha-1 stuck in awaiting_ci.
    const stale = openHealingSession(job.id, 5, "sha-1", db);
    transitionHealingSession(stale.id, "awaiting_slot", db);
    transitionHealingSession(stale.id, "repairing", db);
    transitionHealingSession(stale.id, "awaiting_ci", db);
    const { gh } = scriptedGh([
      [{ name: "test", state: "FAILURE" }],
      [{ name: "test", state: "SUCCESS" }],
    ]);
    const resume = vi.fn(async () => ({ exitCode: 0 }));
    const headSha = vi.fn().mockResolvedValueOnce("sha-1").mockResolvedValue("sha-2");
    const final = await ciBabysitter(job, 5, {
      db,
      gh,
      resumeSession: resume,
      ...fast,
      autoHeal: { headSha, provider: "github" },
    });
    expect(final.status).toBe("merged");
    const sessions = db.select().from(healingSessions).all();
    expect(sessions.find((s) => s.id === stale.id)?.status).toBe("superseded");
    expect(sessions.find((s) => s.id !== stale.id)?.status).toBe("healed");
    expect(activeHealingRunCount(db)).toBe(0);
  });

  it("stays bounded by the heal budget and escalates rather than looping forever", async () => {
    const job = ciRunningJob(4);
    // Always failing; head moves each heal so attempts aren't rejected as empty,
    // but the failing count never drops → no improvement, bounded by budget.
    const { gh } = scriptedGh(Array(12).fill([{ name: "test", state: "FAILURE" }]));
    const resume = vi.fn(async () => ({ exitCode: 0 }));
    let n = 0;
    const headSha = vi.fn(async () => `sha-${n++}`);
    const final = await ciBabysitter(job, 5, {
      db,
      gh,
      resumeSession: resume,
      ...fast,
      autoHeal: { headSha, provider: "github" },
    });
    expect(final.status).toBe("needs_human");
    // Never exceeds the per-session heal budget.
    expect(resume.mock.calls.length).toBeLessThanOrEqual(
      DEFAULT_HEAL_BUDGETS.maxHealAttemptsPerSession,
    );
    expect(getJob(job.id, db)?.status).toBe("needs_human");
  });

  it("holds the merge for the settle window after a heal goes green (issue #159)", async () => {
    const job = ciRunningJob(13);
    const { gh, runner } = scriptedGh([
      [{ name: "test", state: "FAILURE" }], // poll 1: failing → heal
      [{ name: "test", state: "SUCCESS" }], // poll 2+: green, gated
    ]);
    const resume = vi.fn(async () => ({ exitCode: 0 }));
    const headSha = vi.fn().mockResolvedValueOnce("sha-1").mockResolvedValue("sha-2");
    let t = 0;
    const sleep = vi.fn(async () => {
      t += 2 * 60_000;
    });
    const final = await ciBabysitter(job, 5, {
      db,
      gh,
      resumeSession: resume,
      sleep,
      pollMs: 1,
      maxPolls: 20,
      now: () => t,
      mergeGateMs: 5 * 60_000,
      autoHeal: { headSha, provider: "github" },
    });
    expect(resume).toHaveBeenCalledOnce();
    expect(final.status).toBe("merged");
    // Three gated polls (at 0, 2, and 4 min) before the 5-minute window elapses.
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(runner).toHaveBeenCalledWith(
      "gh",
      expect.arrayContaining(["pr", "merge", "5"]),
      "/tmp/r",
    );
  });
});

describe("ciBabysitter auto-heal — merge without CI checks (issue #207)", () => {
  it("escalates a no-checks PR to a human when the policy is off (no heal attempt)", async () => {
    // With the policy off, zero checks must not be mistaken for a failure to
    // heal: no session opens, nothing is resumed, and the job parks for a human.
    const job = ciRunningJob(40);
    const { gh, runner } = scriptedGh([[]]);
    const resume = vi.fn(async () => ({ exitCode: 0 }));
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
      autoHeal: { headSha: vi.fn().mockResolvedValue("sha-1"), provider: "github" },
    });
    expect(final.status).toBe("needs_human");
    expect(final.errorMessage).toContain("CI did not complete in time");
    expect(resume).not.toHaveBeenCalled();
    expect(db.select().from(healingAttempts).all()).toHaveLength(0);
    expect(db.select().from(healingSessions).all()).toHaveLength(0);
    expect(runner).not.toHaveBeenCalledWith(
      "gh",
      expect.arrayContaining(["pr", "merge", "5"]),
      "/tmp/r",
    );
  });

  it("merges a no-checks PR after the settle window when the policy is on", async () => {
    const job = ciRunningJob(41);
    const { gh, runner } = scriptedGh([[]]);
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
      autoHeal: { headSha: vi.fn().mockResolvedValue("sha-1"), provider: "github" },
    });
    expect(final.status).toBe("merged");
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(db.select().from(healingAttempts).all()).toHaveLength(0);
    expect(runner).toHaveBeenCalledWith(
      "gh",
      expect.arrayContaining(["pr", "merge", "5"]),
      "/tmp/r",
    );
  });
});
