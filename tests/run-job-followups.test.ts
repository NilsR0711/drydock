import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { followupIssues, type Job, jobs } from "@/lib/db/schema";
import type { Worktree } from "@/lib/git/worktree";
import type { FollowupIssue } from "@/lib/orchestrator/followups-metadata";
import { createJob, getJob } from "@/lib/orchestrator/jobs";
import { runJob } from "@/lib/orchestrator/run-job";
import { addRepo } from "@/lib/repos/service";

let db: DB;
let repoId: number;
beforeEach(() => {
  db = createDb(":memory:");
  repoId = addRepo({ path: "/repo", name: "acme" }, db).id;
});

function fakeWorktrees() {
  const wt: Worktree = { path: "/wt", branch: "drydock/issue-1-job-1" };
  return {
    prepare: vi.fn(async () => wt),
    commitAndPush: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  };
}

interface PrInput {
  head: string;
  base: string;
  title: string;
  body: string;
}

/** runJob deps that drive a job to merged, capturing the PR input and filed issues. */
function baseDeps(over: Record<string, unknown> = {}) {
  const captured: { pr?: PrInput; issues: FollowupIssue[] } = { issues: [] };
  let nextIssue = 900;
  const deps = {
    db,
    worktrees: fakeWorktrees(),
    runSession: vi.fn(async (job: Job) => {
      db.update(jobs).set({ status: "working", sessionId: "s1" }).where(eq(jobs.id, job.id)).run();
      return { exitCode: 0, sessionId: "s1", costUsd: 0.1, inputTokens: 1, outputTokens: 1 };
    }),
    createPr: vi.fn(async (input: PrInput) => {
      captured.pr = input;
      return 55;
    }),
    createIssue: vi.fn(async (title: string, body: string) => {
      captured.issues.push({ title, body });
      nextIssue += 1;
      return nextIssue;
    }),
    viewIssue: vi.fn(async () => ({ title: "Issue title", body: "Issue body" })),
    runBabysitter: vi.fn(async (job: Job) => {
      db.update(jobs).set({ status: "merged" }).where(eq(jobs.id, job.id)).run();
      return getJob(job.id, db) as Job;
    }),
    ...over,
  };
  return { deps, captured };
}

describe("runJob — agent-authored follow-up issues (issue #261)", () => {
  it("files a real issue per entry, records them, and links them from the PR body", async () => {
    const consumeFollowups = vi.fn((): FollowupIssue[] => [
      { title: "feat(api): paginate issues", body: "Out of scope. Acceptance: cursors." },
      { title: "chore: drop legacy column", body: "Unused since v2." },
    ]);
    const { deps, captured } = baseDeps({ consumeFollowups });
    const job = createJob({ repoId, issueNumber: 1 }, db);

    const final = await runJob(job.id, deps as never);

    expect(consumeFollowups).toHaveBeenCalledWith("/wt");
    // A real issue filed per entry, with the agent's title + body.
    expect(captured.issues).toEqual([
      { title: "feat(api): paginate issues", body: "Out of scope. Acceptance: cursors." },
      { title: "chore: drop legacy column", body: "Unused since v2." },
    ]);
    // Both recorded in followup_issues against the originating job.
    const rows = db.select().from(followupIssues).all();
    expect(rows.map((r) => r.ghIssueNumber).sort()).toEqual([901, 902]);
    expect(rows.every((r) => r.jobId === job.id)).toBe(true);
    // Linked back from the PR body.
    expect(captured.pr?.body).toContain("Spun off: #901, #902");
    expect(final.status).toBe("merged");
  });

  it("does not re-file follow-ups already filed for the job (rerun dedupe)", async () => {
    // Pre-seed a previously filed follow-up for this job lineage.
    const job = createJob({ repoId, issueNumber: 2 }, db);
    db.insert(followupIssues)
      .values({ jobId: job.id, ghIssueNumber: 700, title: "feat(api): paginate issues" })
      .run();

    const consumeFollowups = vi.fn((): FollowupIssue[] => [
      { title: "feat(api): paginate issues", body: "same as before" },
      { title: "fix: brand new follow-up", body: "this one is new" },
    ]);
    const { deps, captured } = baseDeps({ consumeFollowups });

    await runJob(job.id, deps as never);

    // Only the new title is filed; the duplicate reuses the recorded number.
    expect(captured.issues).toEqual([
      { title: "fix: brand new follow-up", body: "this one is new" },
    ]);
    const rows = db.select().from(followupIssues).all();
    expect(rows).toHaveLength(2);
    // PR links both: the reused prior issue and the freshly filed one.
    expect(captured.pr?.body).toContain("Spun off: #700, #901");
  });

  it("opens a PR with no Spun-off line when there are no follow-ups", async () => {
    const consumeFollowups = vi.fn((): FollowupIssue[] => []);
    const { deps, captured } = baseDeps({ consumeFollowups });
    const job = createJob({ repoId, issueNumber: 3 }, db);

    await runJob(job.id, deps as never);

    expect(deps.createIssue).not.toHaveBeenCalled();
    expect(captured.pr?.body).not.toContain("Spun off");
    expect(captured.pr?.body).toContain("Closes #3");
  });

  it("still opens the PR when filing a follow-up fails (best-effort)", async () => {
    const consumeFollowups = vi.fn((): FollowupIssue[] => [
      { title: "feat: deferred work", body: "context" },
    ]);
    const { deps, captured } = baseDeps({
      consumeFollowups,
      createIssue: vi.fn(async () => {
        throw new Error("forge down");
      }),
    });
    const job = createJob({ repoId, issueNumber: 4 }, db);

    const final = await runJob(job.id, deps as never);

    expect(deps.createPr).toHaveBeenCalledTimes(1);
    expect(captured.pr?.body).not.toContain("Spun off");
    expect(final.status).toBe("merged");
  });
});
