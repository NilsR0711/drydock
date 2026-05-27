import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { followupIssues } from "@/lib/db/schema";
import type { PrCheck } from "@/lib/github/gh";
import { GhClient } from "@/lib/github/gh";
import { ciBabysitter, classifyChecks } from "@/lib/orchestrator/ci-babysitter";
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

  it("retries on failure then merges on the next green poll", async () => {
    const job = ciRunningJob(2);
    const { gh } = scriptedGh([
      [{ name: "build", state: "FAILURE" }],
      [{ name: "build", state: "SUCCESS" }],
    ]);
    const resume = vi.fn(async () => {});
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
    const resume = vi.fn(async () => {});
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

  it("gives up after MAX retries -> needs_human + follow-up issue", async () => {
    const job = ciRunningJob(3);
    const { gh } = scriptedGh([[{ name: "build", state: "FAILURE" }]]);
    const resume = vi.fn(async () => {});
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
