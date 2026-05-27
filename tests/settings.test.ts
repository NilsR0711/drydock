import { type DB, createDb } from "@/lib/db/client";
import { jobs } from "@/lib/db/schema";
import { addRepo } from "@/lib/repos/service";
import { getSettings, jobsAllowed, saveSettings } from "@/lib/settings/service";
import { beforeEach, describe, expect, it } from "vitest";

let db: DB;
let repoId: number;
beforeEach(() => {
  db = createDb(":memory:");
  repoId = addRepo({ path: "/tmp/r", name: "r" }, db).id;
});

describe("settings", () => {
  it("returns defaults when unset", () => {
    const s = getSettings(db);
    expect(s.paused).toBe(false);
    expect(s.dailyCostLimitUsd).toBe(10);
    expect(s.maxParallelJobs).toBe(3);
  });

  it("persists and merges patches", () => {
    saveSettings({ paused: true }, db);
    expect(getSettings(db).paused).toBe(true);
    saveSettings({ dailyCostLimitUsd: 25 }, db);
    const s = getSettings(db);
    expect(s.paused).toBe(true);
    expect(s.dailyCostLimitUsd).toBe(25);
  });
});

describe("jobsAllowed gate", () => {
  it("blocks when paused", () => {
    saveSettings({ paused: true }, db);
    expect(jobsAllowed(db)).toEqual({ allowed: false, reason: "paused" });
  });

  it("blocks when today's cost reaches the limit", () => {
    saveSettings({ dailyCostLimitUsd: 1 }, db);
    db.insert(jobs)
      .values({
        repoId,
        issueNumber: 1,
        status: "merged",
        startedAt: Math.floor(Date.now() / 1000),
        costUsd: 1.5,
      })
      .run();
    expect(jobsAllowed(db)).toEqual({ allowed: false, reason: "cost_limit" });
  });

  it("allows when under limit and not paused", () => {
    saveSettings({ dailyCostLimitUsd: 100 }, db);
    expect(jobsAllowed(db).allowed).toBe(true);
  });
});
