import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { jobs } from "@/lib/db/schema";
import { addRepo } from "@/lib/repos/service";
import { getSettings, jobsAllowed, repoJobsAllowed, saveSettings } from "@/lib/settings/service";

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
    expect(s.retentionDays).toBe(30);
  });

  it("persists a custom retention window", () => {
    saveSettings({ retentionDays: 14 }, db);
    expect(getSettings(db).retentionDays).toBe(14);
  });

  it("defaults the CI wait budget and persists an override", () => {
    expect(getSettings(db).maxCiWaitMinutes).toBe(60);
    saveSettings({ maxCiWaitMinutes: 15 }, db);
    expect(getSettings(db).maxCiWaitMinutes).toBe(15);
  });

  it("defaults the per-job cost ceiling to off (0) and persists an override (issue #57)", () => {
    expect(getSettings(db).maxJobCostUsd).toBe(0);
    saveSettings({ maxJobCostUsd: 2.5 }, db);
    expect(getSettings(db).maxJobCostUsd).toBe(2.5);
  });

  it("rejects a negative per-job cost ceiling (issue #57)", () => {
    expect(() => saveSettings({ maxJobCostUsd: -1 }, db)).toThrow();
  });

  it("defaults release management to off and persists an override (issue #59)", () => {
    expect(getSettings(db).releaseManagementEnabled).toBe(false);
    saveSettings({ releaseManagementEnabled: true }, db);
    expect(getSettings(db).releaseManagementEnabled).toBe(true);
  });

  it("defaults notification channels to empty and all events enabled", () => {
    const s = getSettings(db);
    expect(s.slackWebhookUrl).toBe("");
    expect(s.smtpHost).toBe("");
    expect(s.smtpPort).toBe(587);
    expect(s.emailFrom).toBe("");
    expect(s.emailTo).toBe("");
    expect(s.notifyEvents).toEqual([
      "needs_human",
      "job_failed",
      "pr_opened",
      "pr_merged",
      "release_published",
      "cost_limit",
      "automation_paused",
    ]);
  });

  it("persists notification channel config and a custom event subset", () => {
    saveSettings(
      {
        slackWebhookUrl: "https://hooks.slack.com/services/X",
        smtpHost: "smtp.example.com",
        notifyEvents: ["pr_merged", "needs_human"],
      },
      db,
    );
    const s = getSettings(db);
    expect(s.slackWebhookUrl).toBe("https://hooks.slack.com/services/X");
    expect(s.smtpHost).toBe("smtp.example.com");
    expect(s.notifyEvents).toEqual(["pr_merged", "needs_human"]);
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

describe("repoJobsAllowed gate", () => {
  it("blocks when the repo's daily cost hits its limit", () => {
    const repo = addRepo({ path: "/r5", name: "r5", dailyCostLimitUsd: 5 }, db);
    db.insert(jobs)
      .values({
        repoId: repo.id,
        issueNumber: 1,
        startedAt: Math.floor(Date.now() / 1000),
        costUsd: 6,
      })
      .run();
    const gate = repoJobsAllowed(repo.id, db);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe("repo_cost_limit");
  });

  it("allows below the repo limit", () => {
    const repo = addRepo({ path: "/r6", name: "r6", dailyCostLimitUsd: 5 }, db);
    expect(repoJobsAllowed(repo.id, db).allowed).toBe(true);
  });
});
