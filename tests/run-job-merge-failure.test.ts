import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { type Job, jobs } from "@/lib/db/schema";
import type { Worktree } from "@/lib/git/worktree";
import { GhClient } from "@/lib/github/gh";
import { ciBabysitter } from "@/lib/orchestrator/ci-babysitter";
import { createJob, getJob } from "@/lib/orchestrator/jobs";
import { runJob } from "@/lib/orchestrator/run-job";
import { addRepo } from "@/lib/repos/service";

let db: DB;
let repoId: number;
beforeEach(() => {
  db = createDb(":memory:");
  repoId = addRepo({ path: "/repo", name: "acme", defaultModel: "claude-opus-4-7" }, db).id;
});

function fakeWorktrees() {
  const wt: Worktree = { path: "/wt", branch: "drydock/issue-1-job-1" };
  return {
    prepare: vi.fn(async () => wt),
    commitAndPush: vi.fn(async () => {}),
    commitAndPushForHuman: vi.fn(async () => false),
    remove: vi.fn(async () => {}),
  };
}

/** A GhClient whose `pr merge` always fails, CI otherwise green. */
function mergeFailsGh() {
  const runner = vi.fn(async (_cmd: string, args: string[]) => {
    if (args[0] === "pr" && args[1] === "checks") {
      return {
        stdout: JSON.stringify([{ name: "build", state: "SUCCESS" }]),
        stderr: "",
        exitCode: 0,
      };
    }
    if (args[0] === "pr" && args[1] === "merge") {
      return { stdout: "", stderr: "auto-merge is not allowed for this repository", exitCode: 1 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  });
  return new GhClient("/repo", runner);
}

describe("runJob — merge failure after green CI (issue #386)", () => {
  it("ends needs_human with an actionable message and announces it", async () => {
    const announce = vi.fn(async () => {});
    const notify = vi.fn(async () => {});
    const gh = mergeFailsGh();
    const deps = {
      db,
      worktrees: fakeWorktrees(),
      runSession: vi.fn(async (job: Job) => {
        db.update(jobs)
          .set({ status: "working", sessionId: "s1" })
          .where(eq(jobs.id, job.id))
          .run();
        return { exitCode: 0, sessionId: "s1", costUsd: 0.1, inputTokens: 1, outputTokens: 1 };
      }),
      createPr: vi.fn(async () => 55),
      viewIssue: vi.fn(async () => ({ title: "", body: "" })),
      // Exercise the real babysitter so the merge failure flows end-to-end.
      runBabysitter: (job: Job, prNumber: number) =>
        ciBabysitter(job, prNumber, {
          db,
          gh,
          resumeSession: vi.fn(),
          sleep: vi.fn(),
          maxPolls: 3,
        }),
      announceNeedsHuman: announce,
      notify,
      verify: vi.fn(async () => {}),
      audit: vi.fn(async () => {}),
    };
    const job = createJob({ repoId, issueNumber: 1 }, db);

    const result = await runJob(job.id, deps as never);

    expect(result.status).toBe("needs_human");
    expect(result.errorMessage).toMatch(/could not be merged/i);
    expect(getJob(job.id, db)?.status).toBe("needs_human");
    // GitHub-side visibility for the parked job (issue #250) still fires.
    expect(announce).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith("needs_human", expect.stringContaining("Needs human"));
  });
});
