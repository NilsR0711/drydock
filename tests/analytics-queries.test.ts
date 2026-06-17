import { beforeEach, describe, expect, it } from "vitest";
import { analyticsByDimension, analyticsSummary } from "@/lib/db/analytics-queries";
import { createDb, type DB } from "@/lib/db/client";
import { jobs } from "@/lib/db/schema";
import { addRepo } from "@/lib/repos/service";

let db: DB;
let repoId: number;
let otherRepoId: number;

// Distinct UTC days so daily grouping is deterministic regardless of timezone.
const D1 = 1704067200; // 2024-01-01 00:00:00 UTC
const D2 = 1704153600; // 2024-01-02 00:00:00 UTC

beforeEach(() => {
  db = createDb(":memory:");
  repoId = addRepo({ path: "/tmp/r", name: "r" }, db).id;
  otherRepoId = addRepo({ path: "/tmp/o", name: "o" }, db).id;
  db.insert(jobs)
    .values([
      // merged, ttm = 100s, $0.10, 0 retries, finished on day 1
      {
        repoId,
        issueNumber: 1,
        status: "merged",
        startedAt: D1,
        finishedAt: D1 + 100,
        costUsd: 0.1,
        ciRetryCount: 0,
        createdAt: D1 - 100,
      },
      // merged, ttm = 300s, $0.20, 2 retries, finished on day 2
      {
        repoId,
        issueNumber: 2,
        status: "merged",
        startedAt: D2,
        finishedAt: D2 + 300,
        costUsd: 0.2,
        ciRetryCount: 2,
        createdAt: D2 - 100,
      },
      // needs_human (completed but not merged), $0.05, 1 retry, finished on day 2
      {
        repoId,
        issueNumber: 3,
        status: "needs_human",
        startedAt: D2,
        finishedAt: D2 + 50,
        costUsd: 0.05,
        ciRetryCount: 1,
        createdAt: D2 - 100,
      },
      // queued, not finished, no cost
      {
        repoId,
        issueNumber: 4,
        status: "queued",
        startedAt: null,
        finishedAt: null,
        costUsd: 0,
        ciRetryCount: 0,
        createdAt: D2 + 1000,
      },
      // a job in another repo, merged, to verify repo scoping
      {
        repoId: otherRepoId,
        issueNumber: 9,
        status: "merged",
        startedAt: D1,
        finishedAt: D1 + 999,
        costUsd: 5,
        ciRetryCount: 9,
        createdAt: D1,
      },
    ])
    .run();
});

describe("analyticsSummary", () => {
  it("counts total, completed, and merged jobs for a repo", () => {
    const a = analyticsSummary({ repoId }, db);
    expect(a.totalJobs).toBe(4);
    expect(a.completedJobs).toBe(3);
    expect(a.mergedJobs).toBe(2);
  });

  it("computes the merge rate over completed jobs", () => {
    const a = analyticsSummary({ repoId }, db);
    expect(a.mergeRate).toBeCloseTo(2 / 3);
  });

  it("computes p50 and p90 time-to-merge in seconds", () => {
    const a = analyticsSummary({ repoId }, db);
    expect(a.timeToMergeP50Sec).toBe(100);
    expect(a.timeToMergeP90Sec).toBe(300);
  });

  it("averages CI retries over completed jobs", () => {
    const a = analyticsSummary({ repoId }, db);
    expect(a.avgCiRetries).toBeCloseTo((0 + 2 + 1) / 3);
  });

  it("sums cost and derives cost per merged PR", () => {
    const a = analyticsSummary({ repoId }, db);
    expect(a.totalCostUsd).toBeCloseTo(0.35);
    expect(a.costPerMergedUsd).toBeCloseTo(0.35 / 2);
  });

  it("builds a per-day throughput series, newest first", () => {
    const a = analyticsSummary({ repoId }, db);
    expect(a.daily).toHaveLength(2);
    expect(a.daily[0]).toMatchObject({ day: "2024-01-02", completed: 2, merged: 1 });
    expect(a.daily[1]).toMatchObject({ day: "2024-01-01", completed: 1, merged: 1 });
    expect(a.mergedPerDay).toBeCloseTo(1);
  });

  it("scopes every metric to the requested repo", () => {
    const a = analyticsSummary({ repoId }, db);
    // The other repo's merged $5 / 9-retry job must not leak in.
    expect(a.totalCostUsd).toBeCloseTo(0.35);
    expect(a.mergedJobs).toBe(2);
  });

  it("filters by createdAt date range", () => {
    // Only day-2 jobs were created at/after D2 - 100.
    const a = analyticsSummary({ repoId, since: D2 - 100 }, db);
    expect(a.totalJobs).toBe(3); // issues 2, 3, 4
    expect(a.mergedJobs).toBe(1); // only issue 2
  });

  it("returns null efficiency metrics when there is nothing to measure", () => {
    const empty = analyticsSummary({ repoId, since: D2 + 100_000 }, db);
    expect(empty.totalJobs).toBe(0);
    expect(empty.mergeRate).toBe(0);
    expect(empty.timeToMergeP50Sec).toBeNull();
    expect(empty.timeToMergeP90Sec).toBeNull();
    expect(empty.costPerMergedUsd).toBeNull();
    expect(empty.mergedPerDay).toBeNull();
  });
});

describe("analyticsByDimension", () => {
  let dimRepo: number;

  beforeEach(() => {
    dimRepo = addRepo({ path: "/tmp/d", name: "d" }, db).id;
    db.insert(jobs)
      .values([
        // opus / claude / prompt v1: merged, ttm 100s, $0.10, 0 retries
        {
          repoId: dimRepo,
          issueNumber: 1,
          status: "merged",
          model: "claude-opus-4-8",
          agent: "claude",
          implementPromptVersion: 1,
          startedAt: D1,
          finishedAt: D1 + 100,
          costUsd: 0.1,
          ciRetryCount: 0,
          createdAt: D1,
        },
        // opus / claude / prompt v1: merged, ttm 300s, $0.20, 2 retries
        {
          repoId: dimRepo,
          issueNumber: 2,
          status: "merged",
          model: "claude-opus-4-8",
          agent: "claude",
          implementPromptVersion: 1,
          startedAt: D1,
          finishedAt: D1 + 300,
          costUsd: 0.2,
          ciRetryCount: 2,
          createdAt: D1,
        },
        // sonnet / codex / prompt v2: completed but not merged, $0.05, 1 retry
        {
          repoId: dimRepo,
          issueNumber: 3,
          status: "needs_human",
          model: "claude-sonnet-4-6",
          agent: "codex",
          implementPromptVersion: 2,
          startedAt: D2,
          finishedAt: D2 + 50,
          costUsd: 0.05,
          ciRetryCount: 1,
          createdAt: D2,
        },
        // model unset / claude / default prompt: queued, not finished
        {
          repoId: dimRepo,
          issueNumber: 4,
          status: "queued",
          model: null,
          agent: "claude",
          implementPromptVersion: null,
          startedAt: null,
          finishedAt: null,
          costUsd: 0,
          ciRetryCount: 0,
          createdAt: D2,
        },
      ])
      .run();
  });

  it("slices the KPIs by model, busiest slice first", () => {
    const slices = analyticsByDimension("model", { repoId: dimRepo }, db);
    expect(slices.map((s) => s.key)).toEqual(["claude-opus-4-8", "claude-sonnet-4-6", "unknown"]);

    const opus = slices[0];
    expect(opus).toMatchObject({ totalJobs: 2, completedJobs: 2, mergedJobs: 2 });
    expect(opus?.mergeRate).toBeCloseTo(1);
    expect(opus?.timeToMergeP50Sec).toBe(100);
    expect(opus?.timeToMergeP90Sec).toBe(300);
    expect(opus?.avgCiRetries).toBeCloseTo(1);
    expect(opus?.totalCostUsd).toBeCloseTo(0.3);
    expect(opus?.costPerMergedUsd).toBeCloseTo(0.15);
  });

  it("labels an unset model as 'unknown' with null efficiency metrics", () => {
    const unknown = analyticsByDimension("model", { repoId: dimRepo }, db).find(
      (s) => s.key === "unknown",
    );
    expect(unknown).toMatchObject({ totalJobs: 1, completedJobs: 0, mergedJobs: 0 });
    expect(unknown?.mergeRate).toBe(0);
    expect(unknown?.timeToMergeP50Sec).toBeNull();
    expect(unknown?.costPerMergedUsd).toBeNull();
  });

  it("slices the KPIs by agent", () => {
    const slices = analyticsByDimension("agent", { repoId: dimRepo }, db);
    expect(slices.map((s) => s.key)).toEqual(["claude", "codex"]);
    expect(slices.find((s) => s.key === "claude")).toMatchObject({
      totalJobs: 3,
      mergedJobs: 2,
    });
    expect(slices.find((s) => s.key === "codex")).toMatchObject({
      totalJobs: 1,
      mergedJobs: 0,
    });
  });

  it("slices the KPIs by prompt version, labelling the code default", () => {
    const slices = analyticsByDimension("promptVersion", { repoId: dimRepo }, db);
    const keys = slices.map((s) => s.key);
    expect(keys).toContain("v1");
    expect(keys).toContain("v2");
    expect(keys).toContain("default");
    expect(slices.find((s) => s.key === "v1")).toMatchObject({ totalJobs: 2, mergedJobs: 2 });
    expect(slices.find((s) => s.key === "default")).toMatchObject({ totalJobs: 1, mergedJobs: 0 });
  });

  it("honours the repo and date-range filters", () => {
    // Scoped to dimRepo, so the top-level fixtures in other repos never leak in.
    const all = analyticsByDimension("agent", { repoId: dimRepo }, db);
    expect(all.reduce((n, s) => n + s.totalJobs, 0)).toBe(4);

    // Only the two day-2 jobs were created at/after D2.
    const recent = analyticsByDimension("agent", { repoId: dimRepo, since: D2 }, db);
    expect(recent.reduce((n, s) => n + s.totalJobs, 0)).toBe(2);
  });

  it("returns an empty array when no jobs match", () => {
    expect(analyticsByDimension("model", { repoId: dimRepo, since: D2 + 100_000 }, db)).toEqual([]);
  });
});
