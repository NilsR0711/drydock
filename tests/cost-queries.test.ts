import { type DB, createDb } from "@/lib/db/client";
import { costByModel, dailyCosts, topJobs } from "@/lib/db/cost-queries";
import { jobs } from "@/lib/db/schema";
import { addRepo } from "@/lib/repos/service";
import { beforeEach, describe, expect, it } from "vitest";

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
});
