import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { costByModel, dailyCosts, todayCost, topJobs } from "@/lib/db/cost-queries";
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
});
