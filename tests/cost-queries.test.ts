import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import {
  costByModel,
  dailyCosts,
  monthCost,
  projectMonthlySpend,
  todayCost,
  todaySpendByRepo,
  topJobs,
} from "@/lib/db/cost-queries";
import { jobs, oneShotCosts } from "@/lib/db/schema";
import { addRepo } from "@/lib/repos/service";

let db: DB;
let repoId: number;
beforeEach(() => {
  db = createDb(":memory:");
  repoId = addRepo({ path: "/tmp/r", name: "r" }, db).id;
  const now = Math.floor(Date.now() / 1000);
  db.insert(jobs)
    .values([
      {
        repoId,
        issueNumber: 1,
        status: "merged",
        model: "claude-sonnet-4-5",
        startedAt: now,
        totalInputTokens: 1000,
        totalOutputTokens: 200,
        costUsd: 0.05,
      },
      {
        repoId,
        issueNumber: 2,
        status: "merged",
        model: "claude-haiku-4-5",
        startedAt: now,
        totalInputTokens: 2000,
        totalOutputTokens: 400,
        costUsd: 0.02,
      },
    ])
    .run();
});

describe("cost queries", () => {
  it("aggregates daily cost and tokens", () => {
    const days = dailyCosts(db);
    expect(days).toHaveLength(1);
    expect(days[0]?.costUsd).toBeCloseTo(0.07);
    expect(days[0]?.inputTokens).toBe(3000);
  });

  it("aggregates cost by model", () => {
    const byModel = costByModel(db);
    const sonnet = byModel.find((m) => m.model === "claude-sonnet-4-5");
    expect(sonnet?.costUsd).toBeCloseTo(0.05);
  });

  it("ranks top jobs by cost", () => {
    const top = topJobs(10, db);
    expect(top[0]?.costUsd).toBeCloseTo(0.05);
    expect(top).toHaveLength(2);
  });

  it("todayCost filters by repo when given a repoId", () => {
    const b = addRepo({ path: "/b", name: "b" }, db).id;
    const now = Math.floor(Date.now() / 1000);
    db.insert(jobs).values({ repoId: b, issueNumber: 9, startedAt: now, costUsd: 1 }).run();
    expect(todayCost(db, repoId)).toBeCloseTo(0.07);
    expect(todayCost(db, b)).toBeCloseTo(1);
    expect(todayCost(db)).toBeCloseTo(1.07);
  });

  it("dailyCosts filters by repo", () => {
    const b = addRepo({ path: "/b2", name: "b2" }, db).id;
    const now = Math.floor(Date.now() / 1000);
    db.insert(jobs).values({ repoId: b, issueNumber: 9, startedAt: now, costUsd: 1 }).run();
    expect(dailyCosts(db, repoId)[0]?.costUsd).toBeCloseTo(0.07);
  });

  it("todayCost includes one-shot costs from oneShotCosts table (issue #95)", () => {
    const now = Math.floor(Date.now() / 1000);
    db.insert(oneShotCosts)
      .values({
        repoId,
        type: "verify",
        costUsd: 0.01,
        inputTokens: 80,
        outputTokens: 20,
        createdAt: now,
      })
      .run();
    // jobs sum = 0.07, one-shot = 0.01 → total 0.08
    expect(todayCost(db, repoId)).toBeCloseTo(0.08);
    expect(todayCost(db)).toBeCloseTo(0.08);
  });

  it("todayCost one-shot costs scope to repo (issue #95)", () => {
    const b = addRepo({ path: "/b3", name: "b3" }, db).id;
    const now = Math.floor(Date.now() / 1000);
    db.insert(oneShotCosts)
      .values({
        repoId: b,
        type: "decompose",
        costUsd: 0.05,
        inputTokens: 500,
        outputTokens: 100,
        createdAt: now,
      })
      .run();
    // repoId has only its jobs (0.07), not repo b's one-shots
    expect(todayCost(db, repoId)).toBeCloseTo(0.07);
    expect(todayCost(db, b)).toBeCloseTo(0.05);
    expect(todayCost(db)).toBeCloseTo(0.12);
  });

  it("todayCost counts only spend since local midnight, not yesterday (issue #415)", () => {
    const c = addRepo({ path: "/c", name: "c" }, db).id;
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const midnightSec = Math.floor(midnight.getTime() / 1000);
    db.insert(jobs)
      .values([
        { repoId: c, issueNumber: 1, startedAt: midnightSec - 60, costUsd: 5 }, // 23:59 yesterday
        { repoId: c, issueNumber: 2, startedAt: midnightSec + 60, costUsd: 3 }, // 00:01 today
      ])
      .run();
    db.insert(oneShotCosts)
      .values([
        { repoId: c, type: "release", costUsd: 7, createdAt: midnightSec - 60 }, // yesterday
        { repoId: c, type: "decompose", costUsd: 1, createdAt: midnightSec + 60 }, // today
      ])
      .run();
    // Only the two post-midnight rows count: 3 (job) + 1 (one-shot).
    expect(todayCost(db, c)).toBeCloseTo(4);
  });

  it("todaySpendByRepo returns per-repo spend since local midnight (issue #415)", () => {
    const b = addRepo({ path: "/tsbr", name: "tsbr" }, db).id;
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const midnightSec = Math.floor(midnight.getTime() / 1000);
    db.insert(jobs)
      .values([
        { repoId: b, issueNumber: 1, startedAt: midnightSec + 10, costUsd: 0.5 }, // today
        { repoId: b, issueNumber: 2, startedAt: midnightSec - 10, costUsd: 9 }, // yesterday, excluded
      ])
      .run();
    db.insert(oneShotCosts)
      .values({ repoId: b, type: "decompose", costUsd: 0.25, createdAt: midnightSec + 5 })
      .run();

    const map = todaySpendByRepo(db);
    // beforeEach seeded repoId with two jobs started "now" totalling 0.07.
    expect(map.get(repoId)).toBeCloseTo(0.07);
    // 0.5 (job) + 0.25 (one-shot); yesterday's 9 is excluded.
    expect(map.get(b)).toBeCloseTo(0.75);
  });

  it("todaySpendByRepo omits repos with no spend today (issue #415)", () => {
    const idle = addRepo({ path: "/idle", name: "idle" }, db).id;
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const midnightSec = Math.floor(midnight.getTime() / 1000);
    db.insert(jobs)
      .values({ repoId: idle, issueNumber: 1, startedAt: midnightSec - 10, costUsd: 4 }) // yesterday
      .run();
    expect(todaySpendByRepo(db).has(idle)).toBe(false);
  });

  it("todaySpendByRepo totals agree with the global todayCost (issue #415)", () => {
    const b = addRepo({ path: "/agg", name: "agg" }, db).id;
    const now = Math.floor(Date.now() / 1000);
    db.insert(jobs).values({ repoId: b, issueNumber: 5, startedAt: now, costUsd: 1.5 }).run();
    db.insert(oneShotCosts)
      .values({ repoId: b, type: "release", costUsd: 0.3, createdAt: now })
      .run();
    const total = [...todaySpendByRepo(db).values()].reduce((sum, n) => sum + n, 0);
    expect(total).toBeCloseTo(todayCost(db));
  });
});

describe("monthCost (issue #413)", () => {
  it("sums this month's job + one-shot spend and excludes prior months", () => {
    // beforeEach seeded two jobs today (0.05 + 0.02 = 0.07) for repoId.
    const now = Math.floor(Date.now() / 1000);
    // 40 days ago is always outside the current calendar month (a month spans at
    // most 31 days), so this job must never count toward month-to-date.
    const priorMonth = now - 40 * 86400;
    db.insert(jobs)
      .values({ repoId, issueNumber: 3, status: "merged", startedAt: priorMonth, costUsd: 5 })
      .run();
    db.insert(oneShotCosts)
      .values({
        repoId,
        type: "verify",
        costUsd: 0.01,
        inputTokens: 0,
        outputTokens: 0,
        createdAt: now,
      })
      .run();
    // today's 0.07 + today's one-shot 0.01 = 0.08; the prior-month $5 is excluded.
    expect(monthCost(db, repoId)).toBeCloseTo(0.08);
    expect(monthCost(db)).toBeCloseTo(0.08);
  });

  it("scopes to a repo when given a repoId", () => {
    const b = addRepo({ path: "/mb", name: "mb" }, db).id;
    const now = Math.floor(Date.now() / 1000);
    db.insert(jobs).values({ repoId: b, issueNumber: 9, startedAt: now, costUsd: 1 }).run();
    expect(monthCost(db, repoId)).toBeCloseTo(0.07);
    expect(monthCost(db, b)).toBeCloseTo(1);
    expect(monthCost(db)).toBeCloseTo(1.07);
  });
});

describe("projectMonthlySpend (issue #413)", () => {
  it("extrapolates the trailing-7 run rate over the remaining days", () => {
    // $70 over the trailing 7 days → $10/day. Day 10 of 30 → 20 days remain.
    // $100 month-to-date + $10 × 20 = $300 projected.
    const p = projectMonthlySpend({
      monthToDate: 100,
      trailing7Total: 70,
      dayOfMonth: 10,
      daysInMonth: 30,
    });
    expect(p.avgDailySpend).toBeCloseTo(10);
    expect(p.projected).toBeCloseTo(300);
    expect(p.monthToDate).toBe(100);
  });

  it("collapses to month-to-date on the last day of the month", () => {
    const p = projectMonthlySpend({
      monthToDate: 250,
      trailing7Total: 70,
      dayOfMonth: 31,
      daysInMonth: 31,
    });
    expect(p.projected).toBeCloseTo(250);
  });

  it("clamps remaining days at zero when dayOfMonth exceeds daysInMonth", () => {
    const p = projectMonthlySpend({
      monthToDate: 40,
      trailing7Total: 700,
      dayOfMonth: 32,
      daysInMonth: 31,
    });
    expect(p.projected).toBeCloseTo(40);
  });

  it("projects zero from an empty month with no run rate", () => {
    const p = projectMonthlySpend({
      monthToDate: 0,
      trailing7Total: 0,
      dayOfMonth: 1,
      daysInMonth: 30,
    });
    expect(p.avgDailySpend).toBe(0);
    expect(p.projected).toBe(0);
  });
});
