import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { jobs } from "@/lib/db/schema";
import { MODELS } from "@/lib/models";
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

  it("rejects an unknown defaultModel id (issue #93)", () => {
    expect(() => saveSettings({ defaultModel: "claude-nonexistent-99" }, db)).toThrow();
  });

  it("accepts every known model id in defaultModel (issue #93)", () => {
    for (const m of MODELS) {
      saveSettings({ defaultModel: m.id }, db);
      expect(getSettings(db).defaultModel).toBe(m.id);
    }
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
      "claude_limit",
      "codex_limit",
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

describe("openrouter settings (issue #169)", () => {
  it("defaults to disabled with an empty key and sane sync interval", () => {
    const s = getSettings(db);
    expect(s.openrouterEnabled).toBe(false);
    expect(s.openrouterApiKey).toBe("");
    expect(s.openrouterCatalogRefreshHours).toBe(6);
    expect(s.openrouterDefaultModel).toBe("");
    expect(s.openrouterFreeModelsOnly).toBe(false);
    expect(s.openrouterSiteUrl).toBe("");
    expect(s.openrouterAppName).toBe("Drydock");
    expect(s.openrouterLimitAutoWait).toBe(true);
  });

  it("persists the OpenRouter configuration", () => {
    saveSettings(
      {
        openrouterEnabled: true,
        openrouterApiKey: "sk-or-v1-test",
        openrouterCatalogRefreshHours: 12,
        openrouterDefaultModel: "meta-llama/llama-3.3-70b-instruct:free",
        openrouterFreeModelsOnly: true,
      },
      db,
    );
    const s = getSettings(db);
    expect(s.openrouterEnabled).toBe(true);
    expect(s.openrouterApiKey).toBe("sk-or-v1-test");
    expect(s.openrouterCatalogRefreshHours).toBe(12);
    expect(s.openrouterDefaultModel).toBe("meta-llama/llama-3.3-70b-instruct:free");
    expect(s.openrouterFreeModelsOnly).toBe(true);
  });

  it("rejects a refresh interval below 15 minutes", () => {
    expect(() => saveSettings({ openrouterCatalogRefreshHours: 0.1 }, db)).toThrow();
    saveSettings({ openrouterCatalogRefreshHours: 0.25 }, db);
    expect(getSettings(db).openrouterCatalogRefreshHours).toBe(0.25);
  });

  it("keeps defaultAgent restricted to the CLI agents", () => {
    expect(() => saveSettings({ defaultAgent: "openrouter" as unknown as "claude" }, db)).toThrow();
  });
});

describe("jobsAllowed gate", () => {
  it("blocks when paused", () => {
    saveSettings({ paused: true }, db);
    expect(jobsAllowed(db)).toEqual({ allowed: false, reason: "paused" });
  });

  it("blocks when draining (DB-backed so it crosses processes)", () => {
    saveSettings({ draining: true }, db);
    expect(jobsAllowed(db)).toEqual({ allowed: false, reason: "draining" });
    saveSettings({ draining: false }, db);
    expect(jobsAllowed(db).allowed).toBe(true);
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
