import { beforeEach, describe, expect, it } from "vitest";
import { analyticsSummary } from "@/lib/db/analytics-queries";
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
