import { describe, expect, it, vi } from "vitest";
import type { Job } from "@/lib/db/schema";
import { EmptyCommitError, type Worktree } from "@/lib/git/worktree";
import { resumeFailureReason } from "@/lib/orchestrator/ci-babysitter";
import { buildCiFixResume } from "@/lib/orchestrator/job-prompts";

const job = { id: 9, issueNumber: 3 } as Job;
const wt: Worktree = { path: "/wts/job-9", branch: "drydock/issue-3-job-9" };

const session = (exitCode: number) => ({
  exitCode,
  timedOut: false,
  costExceeded: false,
  maxTurnsReached: false,
  sessionId: "s",
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
});
const okSession = async () => session(0);

describe("buildCiFixResume", () => {
  it("resumes in the job worktree and commits + pushes the fix", async () => {
    const commitAndPush = vi.fn(async () => {});
    const resume = vi.fn(okSession);
    const fixResume = buildCiFixResume({
      worktrees: { commitAndPush },
      worktree: () => wt,
      resume,
    });
    const outcome = await fixResume(job, "sess", "log");
    expect(resume).toHaveBeenCalledWith(job, "sess", "log", wt.path);
    expect(commitAndPush).toHaveBeenCalledWith(wt, "Fix CI for #3");
    expect(resumeFailureReason(outcome)).toBeNull();
  });

  it("never pushes when the job was settled externally during the fix session", async () => {
    const commitAndPush = vi.fn(async () => {});
    const fixResume = buildCiFixResume({
      worktrees: { commitAndPush },
      worktree: () => wt,
      settled: () => true,
      resume: okSession,
    });
    const outcome = await fixResume(job, "sess", "log");
    expect(commitAndPush).not.toHaveBeenCalled();
    expect(outcome.settledExternally).toBe(true);
    expect(resumeFailureReason(outcome)).toMatch(/settled externally/);
  });

  it("reports a no-change fix session instead of treating it as success", async () => {
    const commitAndPush = vi.fn(async () => {
      throw new EmptyCommitError();
    });
    const fixResume = buildCiFixResume({
      worktrees: { commitAndPush },
      worktree: () => wt,
      resume: okSession,
    });
    const outcome = await fixResume(job, "sess", "log");
    expect(outcome.noChanges).toBe(true);
    expect(resumeFailureReason(outcome)).toMatch(/no changes/);
  });

  it("skips the push when the fix session itself already failed", async () => {
    const commitAndPush = vi.fn(async () => {});
    const fixResume = buildCiFixResume({
      worktrees: { commitAndPush },
      worktree: () => wt,
      resume: async () => session(1),
    });
    const outcome = await fixResume(job, "sess", "log");
    expect(commitAndPush).not.toHaveBeenCalled();
    expect(resumeFailureReason(outcome)).toMatch(/non-zero/);
  });
});
