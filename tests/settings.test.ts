import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { jobs } from "@/lib/db/schema";
import { getServerLogger } from "@/lib/log/server-log";
import { MODELS } from "@/lib/models";
import { saveCredentialStatus } from "@/lib/orchestrator/credential-status";
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
    // Fully-autonomous out of the box (issue #254): no daily cost ceiling and an
    // unlimited turn budget so a normal task finishes without manual tuning,
    // bounded only by maxJobMinutes / the per-job cost cap.
    expect(s.dailyCostLimitUsd).toBe(0);
    expect(s.maxTurns).toBe(0);
    expect(s.maxJobMinutes).toBe(120);
    expect(s.maxParallelJobs).toBe(3);
    expect(s.retentionDays).toBe(30);
  });

  it("defaults onboarding as not-yet-seen and persists a completion timestamp (issue #356)", () => {
    // Null until the first-run flow is finished/dismissed, which is what the
    // root layout keys the auto-open decision off.
    expect(getSettings(db).onboardingCompletedAt).toBeNull();
    saveSettings({ onboardingCompletedAt: 1_700_000_000 }, db);
    expect(getSettings(db).onboardingCompletedAt).toBe(1_700_000_000);
  });

  it("treats maxTurns = 0 as an allowed (unlimited) budget and rejects negatives (issue #254)", () => {
    saveSettings({ maxTurns: 0 }, db);
    expect(getSettings(db).maxTurns).toBe(0);
    saveSettings({ maxTurns: 500 }, db);
    expect(getSettings(db).maxTurns).toBe(500);
    expect(() => saveSettings({ maxTurns: -1 }, db)).toThrow();
  });

  it("defaults the server log level to info and rejects unknown levels (issue #294)", () => {
    expect(getSettings(db).logLevel).toBe("info");
    saveSettings({ logLevel: "warn" }, db);
    expect(getSettings(db).logLevel).toBe("warn");
    // @ts-expect-error — exercising the runtime guard with an invalid level
    expect(() => saveSettings({ logLevel: "verbose" }, db)).toThrow();
  });

  it("pushes a saved log level down to the live server logger (issue #294)", () => {
    saveSettings({ logLevel: "error" }, db);
    expect(getServerLogger().getLevel()).toBe("error");
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

  it("defaults the per-tick watchdog deadline and persists an override (issue #359)", () => {
    expect(getSettings(db).maxTickSeconds).toBe(120);
    saveSettings({ maxTickSeconds: 45 }, db);
    expect(getSettings(db).maxTickSeconds).toBe(45);
    // 0 disables the watchdog; negatives are rejected.
    saveSettings({ maxTickSeconds: 0 }, db);
    expect(getSettings(db).maxTickSeconds).toBe(0);
    expect(() => saveSettings({ maxTickSeconds: -1 }, db)).toThrow();
    // Rejected above Node's 32-bit setTimeout ceiling (2_147_483s * 1000 ms),
    // where the watchdog timer would otherwise fire after 1ms and abandon every
    // tick instantly.
    expect(() => saveSettings({ maxTickSeconds: 2_147_484 }, db)).toThrow();
  });

  it("defaults the per-job cost ceiling to off (0) and persists an override (issue #57)", () => {
    expect(getSettings(db).maxJobCostUsd).toBe(0);
    saveSettings({ maxJobCostUsd: 2.5 }, db);
    expect(getSettings(db).maxJobCostUsd).toBe(2.5);
  });

  it("rejects a negative per-job cost ceiling (issue #57)", () => {
    expect(() => saveSettings({ maxJobCostUsd: -1 }, db)).toThrow();
  });

  it("defaults the needs-human sound to on and persists an override (issue #258)", () => {
    expect(getSettings(db).needsHumanSoundEnabled).toBe(true);
    saveSettings({ needsHumanSoundEnabled: false }, db);
    expect(getSettings(db).needsHumanSoundEnabled).toBe(false);
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
      "auth_expired",
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

describe("openrouter key bridge (issue #349, ADR 039)", () => {
  it("defaults the OpenRouter API key to empty and drops the retired settings", () => {
    const s = getSettings(db) as Record<string, unknown>;
    expect(s.openrouterApiKey).toBe("");
    // The bespoke OpenRouter backend settings are gone (ADR 039).
    expect(s.openrouterEnabled).toBeUndefined();
    expect(s.openrouterCatalogRefreshHours).toBeUndefined();
    expect(s.openrouterDefaultModel).toBeUndefined();
    expect(s.openrouterFreeModelsOnly).toBeUndefined();
    expect(s.openrouterLimitAutoWait).toBeUndefined();
  });

  it("persists the OpenRouter API key bridged onto opencode", () => {
    saveSettings({ openrouterApiKey: "sk-or-v1-test" }, db);
    expect(getSettings(db).openrouterApiKey).toBe("sk-or-v1-test");
  });

  it("keeps defaultAgent restricted to the static-catalog CLI agents", () => {
    expect(() => saveSettings({ defaultAgent: "openrouter" as unknown as "claude" }, db)).toThrow();
    expect(() => saveSettings({ defaultAgent: "opencode" as unknown as "claude" }, db)).toThrow();
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

  it("treats a daily cost limit of 0 as unlimited (issue #234)", () => {
    saveSettings({ dailyCostLimitUsd: 0 }, db);
    db.insert(jobs)
      .values({
        repoId,
        issueNumber: 1,
        status: "merged",
        startedAt: Math.floor(Date.now() / 1000),
        costUsd: 999,
      })
      .run();
    expect(jobsAllowed(db).allowed).toBe(true);
  });

  it("blocks with reason auth while credential failures are persisted (issue #177)", () => {
    saveCredentialStatus(
      {
        checkedAt: 1,
        failures: [{ target: "github", label: "GitHub CLI auth", message: "token invalid" }],
      },
      db,
    );
    expect(jobsAllowed(db)).toEqual({ allowed: false, reason: "auth" });
  });

  it("resumes automatically once a healthy probe clears the failures", () => {
    saveCredentialStatus(
      {
        checkedAt: 1,
        failures: [{ target: "github", label: "GitHub CLI auth", message: "token invalid" }],
      },
      db,
    );
    saveCredentialStatus({ checkedAt: 2, failures: [] }, db);
    expect(jobsAllowed(db).allowed).toBe(true);
  });

  it("reports paused over auth when both gates are closed", () => {
    saveSettings({ paused: true }, db);
    saveCredentialStatus(
      {
        checkedAt: 1,
        failures: [{ target: "github", label: "GitHub CLI auth", message: "token invalid" }],
      },
      db,
    );
    expect(jobsAllowed(db)).toEqual({ allowed: false, reason: "paused" });
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

  it("treats a repo daily cost limit of 0 as unlimited (issue #234)", () => {
    const repo = addRepo({ path: "/r7", name: "r7", dailyCostLimitUsd: 0 }, db);
    db.insert(jobs)
      .values({
        repoId: repo.id,
        issueNumber: 1,
        startedAt: Math.floor(Date.now() / 1000),
        costUsd: 999,
      })
      .run();
    expect(repoJobsAllowed(repo.id, db).allowed).toBe(true);
  });
});
