import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { type Job, jobs } from "@/lib/db/schema";
import type { Worktree } from "@/lib/git/worktree";
import { createJob, getJob } from "@/lib/orchestrator/jobs";
import { planPromptSection, runJob } from "@/lib/orchestrator/run-job";
import { addRepo } from "@/lib/repos/service";

let db: DB;
beforeEach(() => {
  db = createDb(":memory:");
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

function baseDeps(over: Record<string, unknown> = {}) {
  return {
    db,
    worktrees: fakeWorktrees(),
    runSession: vi.fn(async (job: Job) => {
      db.update(jobs).set({ status: "working", sessionId: "s1" }).where(eq(jobs.id, job.id)).run();
      return { exitCode: 0, sessionId: "s1", costUsd: 0.1, inputTokens: 1, outputTokens: 1 };
    }),
    createPr: vi.fn(async () => 55),
    viewIssue: vi.fn(async () => ({ title: "", body: "" })),
    runBabysitter: vi.fn(async (job: Job) => {
      db.update(jobs).set({ status: "merged" }).where(eq(jobs.id, job.id)).run();
      return getJob(job.id, db) as Job;
    }),
    ...over,
  };
}

describe("planPromptSection", () => {
  it("renders the plan as a dedicated section", () => {
    const section = planPromptSection("1. Edit a.ts\n2. Run tests");
    expect(section).toContain("## Implementation plan");
    expect(section).toContain("1. Edit a.ts");
  });

  it("returns an empty string for an empty plan", () => {
    expect(planPromptSection("   ")).toBe("");
  });

  it("caps an oversized plan", () => {
    const section = planPromptSection("x".repeat(50_000));
    expect(section.length).toBeLessThan(11_000);
    expect(section).toContain("… (truncated)");
  });
});

describe("runJob — plan-first stage (issue #160)", () => {
  it("does not run the plan stage when planFirst is off", async () => {
    const repoId = addRepo({ path: "/repo", name: "acme" }, db).id;
    const runPlan = vi.fn();
    const deps = baseDeps({ runPlan, commentIssue: vi.fn() });
    const job = createJob({ repoId, issueNumber: 1 }, db);
    const result = await runJob(job.id, deps as never);
    expect(result.status).toBe("merged");
    expect(runPlan).not.toHaveBeenCalled();
  });

  it("runs the plan before the session, embeds it in the prompt, and comments it", async () => {
    const repoId = addRepo({ path: "/repo", name: "acme", planFirst: true }, db).id;
    const calls: string[] = [];
    const runPlan = vi.fn(async (_job: Job, _prompt: string, _cwd: string) => {
      calls.push("plan");
      return { text: "1. Edit a.ts\n2. Run tests", exitCode: 0 };
    });
    const commentIssue = vi.fn(async () => {
      calls.push("comment");
    });
    const runSession = vi.fn(async (job: Job, _prompt: string, _cwd: string) => {
      calls.push("session");
      db.update(jobs).set({ status: "working", sessionId: "s1" }).where(eq(jobs.id, job.id)).run();
      return { exitCode: 0, sessionId: "s1", costUsd: 0.1, inputTokens: 1, outputTokens: 1 };
    });
    const deps = baseDeps({ runPlan, commentIssue, runSession });
    const job = createJob({ repoId, issueNumber: 1 }, db);
    const result = await runJob(job.id, deps as never);

    expect(result.status).toBe("merged");
    expect(calls).toEqual(["plan", "comment", "session"]);
    // The plan prompt addresses the issue, not the implementation.
    const planPrompt = runPlan.mock.calls[0]?.[1] as string;
    expect(planPrompt).toContain("issue #1");
    expect(planPrompt).toContain("plan");
    // The implementation prompt carries the plan section.
    const sessionPrompt = runSession.mock.calls[0]?.[1] as string;
    expect(sessionPrompt).toContain("## Implementation plan");
    expect(sessionPrompt).toContain("1. Edit a.ts");
    // The issue comment carries the plan text.
    expect(commentIssue).toHaveBeenCalledWith(1, expect.stringContaining("1. Edit a.ts"));
  });

  it("falls back to the single-stage run when the plan stage fails", async () => {
    const repoId = addRepo({ path: "/repo", name: "acme", planFirst: true }, db).id;
    const runPlan = vi.fn(async () => ({ text: "", exitCode: 1 }));
    const commentIssue = vi.fn();
    const deps = baseDeps({ runPlan, commentIssue });
    const job = createJob({ repoId, issueNumber: 1 }, db);
    const result = await runJob(job.id, deps as never);

    expect(result.status).toBe("merged");
    expect(commentIssue).not.toHaveBeenCalled();
    const sessionPrompt = (deps.runSession as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1] as string;
    expect(sessionPrompt).not.toContain("## Implementation plan");
  });

  it("falls back when the plan runner throws", async () => {
    const repoId = addRepo({ path: "/repo", name: "acme", planFirst: true }, db).id;
    const runPlan = vi.fn(async () => {
      throw new Error("plan boom");
    });
    const deps = baseDeps({ runPlan, commentIssue: vi.fn() });
    const job = createJob({ repoId, issueNumber: 1 }, db);
    const result = await runJob(job.id, deps as never);
    expect(result.status).toBe("merged");
  });

  it("still implements with the plan when posting the comment fails", async () => {
    const repoId = addRepo({ path: "/repo", name: "acme", planFirst: true }, db).id;
    const runPlan = vi.fn(async () => ({ text: "1. Edit a.ts", exitCode: 0 }));
    const commentIssue = vi.fn(async () => {
      throw new Error("forge down");
    });
    const deps = baseDeps({ runPlan, commentIssue });
    const job = createJob({ repoId, issueNumber: 1 }, db);
    const result = await runJob(job.id, deps as never);

    expect(result.status).toBe("merged");
    const sessionPrompt = (deps.runSession as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1] as string;
    expect(sessionPrompt).toContain("## Implementation plan");
  });
});
