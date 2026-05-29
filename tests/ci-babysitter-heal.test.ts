import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { followupIssues, healingAttempts, healingSessions } from "@/lib/db/schema";
import type { PrCheck } from "@/lib/github/gh";
import { GhClient } from "@/lib/github/gh";
import { ciBabysitter } from "@/lib/orchestrator/ci-babysitter";
import { DEFAULT_HEAL_BUDGETS } from "@/lib/orchestrator/ci-healing";
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
    const resume = vi.fn(async () => {});
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
    const resume = vi.fn(async () => {});
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
    const resume = vi.fn(async () => {});
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
    const resume = vi.fn(async () => {});
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

  it("stays bounded by the heal budget and escalates rather than looping forever", async () => {
    const job = ciRunningJob(4);
    // Always failing; head moves each heal so attempts aren't rejected as empty,
    // but the failing count never drops → no improvement, bounded by budget.
    const { gh } = scriptedGh(Array(12).fill([{ name: "test", state: "FAILURE" }]));
    const resume = vi.fn(async () => {});
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
});
