import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { getRepo } from "@/lib/db/queries";
import type { Repo, TrackedPr } from "@/lib/db/schema";
import type { ReviewThread } from "@/lib/forge/types";
import { runAgentOnTrackedPr } from "@/lib/orchestrator/tracked-pr-agent";
import { applyTrackedPrCiFix } from "@/lib/orchestrator/tracked-pr-ci-heal";
import { driveTrackedPrFeedback } from "@/lib/orchestrator/tracked-pr-feedback";
import { addRepo } from "@/lib/repos/service";
import { trackPr } from "@/lib/tracked-prs/service";

function fakeWorktrees() {
  return {
    prepareForBranch: vi.fn(async () => ({ path: "/wt", branch: "b", baseSha: "x" })),
    commitAndPush: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  };
}

describe("runAgentOnTrackedPr", () => {
  let db: DB;
  let repo: Repo;
  let tracked: TrackedPr;

  beforeEach(() => {
    db = createDb(":memory:");
    const id = addRepo({ path: "/repo", name: "acme" }, db).id;
    repo = getRepo(id, db) as Repo;
    tracked = trackPr({ repoId: id, prNumber: 7, url: "u", platform: "github" }, db);
    tracked = { ...tracked, branch: "drydock/x" };
  });

  const opts = { prompt: "fix it", commitMessage: "msg", type: "pr_heal" as const, key: "k" };

  it("checks out, runs the agent, commits, pushes, and cleans up on success", async () => {
    const wts = fakeWorktrees();
    const runAgent = vi.fn(async () => 0);
    const pushed = await runAgentOnTrackedPr(tracked, repo, opts, { db, worktrees: wts, runAgent });
    expect(pushed).toBe(true);
    expect(wts.prepareForBranch).toHaveBeenCalledWith(repo, "drydock/x", "k");
    expect(wts.commitAndPush).toHaveBeenCalledOnce();
    expect(wts.remove).toHaveBeenCalledOnce();
  });

  it("reports failure and skips push when the agent exits non-zero", async () => {
    const wts = fakeWorktrees();
    const pushed = await runAgentOnTrackedPr(tracked, repo, opts, {
      db,
      worktrees: wts,
      runAgent: vi.fn(async () => 1),
    });
    expect(pushed).toBe(false);
    expect(wts.commitAndPush).not.toHaveBeenCalled();
    expect(wts.remove).toHaveBeenCalledOnce(); // still cleans up
  });

  it("reports failure when the commit is empty (no change produced)", async () => {
    const wts = fakeWorktrees();
    wts.commitAndPush.mockRejectedValueOnce(new Error("nothing to commit"));
    const pushed = await runAgentOnTrackedPr(tracked, repo, opts, {
      db,
      worktrees: wts,
      runAgent: vi.fn(async () => 0),
    });
    expect(pushed).toBe(false);
  });

  it("returns false without touching anything when the PR has no branch", async () => {
    const wts = fakeWorktrees();
    const pushed = await runAgentOnTrackedPr({ ...tracked, branch: null }, repo, opts, {
      db,
      worktrees: wts,
      runAgent: vi.fn(async () => 0),
    });
    expect(pushed).toBe(false);
    expect(wts.prepareForBranch).not.toHaveBeenCalled();
  });
});

describe("applyTrackedPrCiFix", () => {
  let db: DB;
  let repo: Repo;
  let tracked: TrackedPr;

  beforeEach(() => {
    db = createDb(":memory:");
    const id = addRepo({ path: "/repo", name: "acme" }, db).id;
    repo = getRepo(id, db) as Repo;
    tracked = {
      ...trackPr({ repoId: id, prNumber: 7, url: "u", platform: "github" }, db),
      branch: "drydock/x",
    };
  });

  it("feeds the failing CI log into the agent and pushes a fix", async () => {
    const wts = fakeWorktrees();
    const runAgent = vi.fn(async (_r, prompt: string) => {
      expect(prompt).toContain("CI checks");
      expect(prompt).toContain("boom: build failed");
      return 0;
    });
    const forge = {
      failedRunLog: vi.fn(async () => "boom: build failed"),
    } as never;
    const pushed = await applyTrackedPrCiFix(tracked, repo, forge, {
      db,
      worktrees: wts,
      runAgent,
    });
    expect(pushed).toBe(true);
    expect(wts.commitAndPush).toHaveBeenCalledOnce();
  });
});

describe("driveTrackedPrFeedback", () => {
  let db: DB;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  const thread = (over: Partial<ReviewThread> = {}): ReviewThread => ({
    id: "T1",
    isResolved: false,
    isOutdated: false,
    path: "src/x.ts",
    line: 3,
    comments: [
      {
        id: "C1",
        databaseId: 1,
        body: "please rename foo to bar",
        author: "coderabbitai[bot]",
        authorIsBot: true,
      },
    ],
    ...over,
  });

  function reviewForge() {
    return {
      listReviewThreads: vi.fn(async () => [thread()]),
      replyToReviewThread: vi.fn(async () => {}),
      updateReviewComment: vi.fn(async () => {}),
      resolveReviewThread: vi.fn(async () => {}),
      reactToReviewComment: vi.fn(async () => {}),
    };
  }

  it("applies trusted-bot feedback by running the agent on an owned branch", async () => {
    const id = addRepo(
      { path: "/repo", name: "acme", autoReviewFeedback: true, trustedBots: ["coderabbitai[bot]"] },
      db,
    ).id;
    const repo = getRepo(id, db) as Repo;
    const tracked = {
      ...trackPr({ repoId: id, prNumber: 7, url: "u", platform: "github" }, db),
      branch: "drydock/x",
      isFork: false,
    };
    const forge = reviewForge();
    const runAgent = vi.fn(async () => 0);
    await driveTrackedPrFeedback(tracked, repo, forge as never, {
      db,
      agent: { db, worktrees: fakeWorktrees(), runAgent },
    });
    expect(runAgent).toHaveBeenCalledOnce();
    expect(forge.resolveReviewThread).toHaveBeenCalledWith("T1");
  });

  it("never runs the agent on a fork PR — flags for a human instead", async () => {
    const id = addRepo(
      { path: "/repo", name: "acme", autoReviewFeedback: true, trustedBots: ["coderabbitai[bot]"] },
      db,
    ).id;
    const repo = getRepo(id, db) as Repo;
    const tracked = {
      ...trackPr({ repoId: id, prNumber: 7, url: "u", platform: "github" }, db),
      branch: "feature/x",
      isFork: true,
    };
    const forge = reviewForge();
    const runAgent = vi.fn(async () => 0);
    await driveTrackedPrFeedback(tracked, repo, forge as never, {
      db,
      agent: { db, worktrees: fakeWorktrees(), runAgent },
    });
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("is inert when the repo has not opted into review feedback", async () => {
    const id = addRepo({ path: "/repo", name: "acme", autoReviewFeedback: false }, db).id;
    const repo = getRepo(id, db) as Repo;
    const tracked = {
      ...trackPr({ repoId: id, prNumber: 7, url: "u", platform: "github" }, db),
      branch: "drydock/x",
    };
    const forge = reviewForge();
    await driveTrackedPrFeedback(tracked, repo, forge as never, { db });
    expect(forge.listReviewThreads).not.toHaveBeenCalled();
  });
});
