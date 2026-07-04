import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { jobs, settings } from "@/lib/db/schema";
import { getServerLogger } from "@/lib/log/server-log";
import type { LogRecord } from "@/lib/log/types";
import { MODELS } from "@/lib/models";
import { NOTIFICATION_EVENTS } from "@/lib/notify/events";
import { saveCredentialStatus } from "@/lib/orchestrator/credential-status";
import { addRepo } from "@/lib/repos/service";
import {
  getSettings,
  jobsAllowed,
  redactSettingsSecrets,
  repoJobsAllowed,
  SECRET_SETTING_KEYS,
  SETTINGS_BACKUP_KEY,
  SETTINGS_REDACTION_PLACEHOLDER,
  saveSettings,
  settingsSchema,
} from "@/lib/settings/service";

/** Storage key the global settings row lives under (mirrors the service constant). */
const GLOBAL_KEY = "global";

/** Overwrite the persisted global settings row with a raw (possibly corrupt) value. */
function writeRawSettings(database: DB, value: string): void {
  const existing = database.select().from(settings).where(eq(settings.key, GLOBAL_KEY)).get();
  if (existing) {
    database.update(settings).set({ value }).where(eq(settings.key, GLOBAL_KEY)).run();
  } else {
    database.insert(settings).values({ key: GLOBAL_KEY, value }).run();
  }
}

/** Run `fn` while capturing every log record the shared server logger emits. */
function captureLogs<T>(fn: () => T): { result: T; records: LogRecord[] } {
  const records: LogRecord[] = [];
  const unsubscribe = getServerLogger().subscribe((r) => records.push(r));
  try {
    return { result: fn(), records };
  } finally {
    unsubscribe();
  }
}

/** Read the raw backup row written whenever a corrupt settings row is recovered. */
function readBackup(database: DB): string | undefined {
  return database.select().from(settings).where(eq(settings.key, SETTINGS_BACKUP_KEY)).get()?.value;
}

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

  it("defaults the backup retention to 7 days and treats 0 as disabling the sweep (issue #411)", () => {
    // Matches the historical RETENTION_DAYS; 0 turns the in-process backup sweep
    // off entirely, and a negative window is rejected.
    expect(getSettings(db).backupRetentionDays).toBe(7);
    saveSettings({ backupRetentionDays: 14 }, db);
    expect(getSettings(db).backupRetentionDays).toBe(14);
    saveSettings({ backupRetentionDays: 0 }, db);
    expect(getSettings(db).backupRetentionDays).toBe(0);
    expect(() => saveSettings({ backupRetentionDays: -1 }, db)).toThrow();
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

  it("defaults the monthly cost limit to off (0), persists it, and rejects negatives (issue #413)", () => {
    expect(getSettings(db).monthlyCostLimitUsd).toBe(0);
    saveSettings({ monthlyCostLimitUsd: 200 }, db);
    expect(getSettings(db).monthlyCostLimitUsd).toBe(200);
    expect(() => saveSettings({ monthlyCostLimitUsd: -1 }, db)).toThrow();
  });
});

describe("corrupt settings row recovery (issue #421)", () => {
  it("falls back to defaults, logs the parse error, and backs up a non-JSON row", () => {
    writeRawSettings(db, "{ this is not valid json");

    const { result: s, records } = captureLogs(() => getSettings(db));

    // Nothing is recoverable from non-JSON, so every field returns to its default.
    expect(s.dailyCostLimitUsd).toBe(0);
    expect(s.maxParallelJobs).toBe(3);
    // The reset is visible in the shared logger at error level.
    expect(records.some((r) => r.level === "error" && /settings/i.test(r.msg))).toBe(true);
    // The raw pre-reset bytes are preserved so the operator can recover them.
    expect(readBackup(db)).toBe("{ this is not valid json");
  });

  it("keeps every still-valid field when a single field is invalid (unknown model id)", () => {
    const good = settingsSchema.parse({
      telegramBotToken: "123456:AAsecret",
      smtpPass: "hunter2",
      dailyCostLimitUsd: 42,
      paused: true,
      maxParallelJobs: 7,
    });
    writeRawSettings(db, JSON.stringify({ ...good, defaultModel: "claude-removed-99" }));

    const { result: s, records } = captureLogs(() => getSettings(db));

    // Secrets, budget, pause, and parallelism survive the bad field.
    expect(s.telegramBotToken).toBe("123456:AAsecret");
    expect(s.smtpPass).toBe("hunter2");
    expect(s.dailyCostLimitUsd).toBe(42);
    expect(s.paused).toBe(true);
    expect(s.maxParallelJobs).toBe(7);
    // Only the offending field falls back to its own default.
    expect(s.defaultModel).toBe("claude-opus-4-8");
    // The log names the failing field (the underlying zod issue).
    expect(records.some((r) => r.level === "error" && r.msg.includes("defaultModel"))).toBe(true);
    // The corrupt row is preserved verbatim for recovery.
    expect(readBackup(db)).toBe(JSON.stringify({ ...good, defaultModel: "claude-removed-99" }));
  });

  it("keeps every still-valid field when a notify event was renamed away", () => {
    const good = settingsSchema.parse({
      openrouterApiKey: "sk-or-v1-secret",
      dailyCostLimitUsd: 15,
      paused: true,
      maxParallelJobs: 5,
    });
    writeRawSettings(
      db,
      JSON.stringify({ ...good, notifyEvents: ["needs_human", "renamed_event"] }),
    );

    const { result: s, records } = captureLogs(() => getSettings(db));

    expect(s.openrouterApiKey).toBe("sk-or-v1-secret");
    expect(s.dailyCostLimitUsd).toBe(15);
    expect(s.paused).toBe(true);
    expect(s.maxParallelJobs).toBe(5);
    // The invalid array resets to the full default set, not to an empty one.
    expect(s.notifyEvents).toEqual([...NOTIFICATION_EVENTS]);
    expect(records.some((r) => r.level === "error" && r.msg.includes("notifyEvents"))).toBe(true);
  });

  it("does not persist a defaults wipe when saveSettings runs after a corruption", () => {
    const good = settingsSchema.parse({
      telegramBotToken: "keep-me",
      smtpPass: "s3cret",
      dailyCostLimitUsd: 33,
      paused: true,
      maxParallelJobs: 6,
    });
    writeRawSettings(db, JSON.stringify({ ...good, defaultModel: "gone-model" }));

    // The operator changes one unrelated field; the recoverable fields must survive.
    saveSettings({ pollIntervalSec: 45 }, db);

    const s = getSettings(db);
    expect(s.pollIntervalSec).toBe(45);
    expect(s.telegramBotToken).toBe("keep-me");
    expect(s.smtpPass).toBe("s3cret");
    expect(s.dailyCostLimitUsd).toBe(33);
    expect(s.paused).toBe(true);
    expect(s.maxParallelJobs).toBe(6);
    expect(s.defaultModel).toBe("claude-opus-4-8");

    // The persisted row is valid again, so re-reading it triggers no further fallback.
    const { records } = captureLogs(() => getSettings(db));
    expect(records.some((r) => r.level === "error" && /settings/i.test(r.msg))).toBe(false);
  });

  it("preserves the raw value once and does not clobber the backup on repeated reads", () => {
    const raw = "not-json-at-all";
    writeRawSettings(db, raw);
    getSettings(db);
    getSettings(db);
    expect(readBackup(db)).toBe(raw);
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

describe("redactSettingsSecrets", () => {
  it("masks every non-empty credential field, including the OpenRouter key", () => {
    const redacted = redactSettingsSecrets({
      telegramBotToken: "123456:AAtoken",
      slackWebhookUrl: "https://hooks.slack.com/services/T/B/secret",
      smtpPass: "hunter2",
      openrouterApiKey: "sk-or-v1-secret",
    });
    for (const key of SECRET_SETTING_KEYS) {
      expect(redacted[key]).toBe(SETTINGS_REDACTION_PLACEHOLDER);
    }
  });

  it("leaves empty credential fields empty rather than masking them", () => {
    const redacted = redactSettingsSecrets({ telegramBotToken: "", smtpPass: "" });
    expect(redacted.telegramBotToken).toBe("");
    expect(redacted.smtpPass).toBe("");
  });

  it("leaves non-secret configuration fields untouched", () => {
    const redacted = redactSettingsSecrets({
      telegramChatId: "chat-1",
      smtpUser: "mailer",
      emailFrom: "bot@example.com",
      maxParallelJobs: 3,
    });
    expect(redacted.telegramChatId).toBe("chat-1");
    expect(redacted.smtpUser).toBe("mailer");
    expect(redacted.emailFrom).toBe("bot@example.com");
    expect(redacted.maxParallelJobs).toBe(3);
  });

  it("returns a copy without mutating the input", () => {
    const input = { smtpPass: "hunter2" };
    const redacted = redactSettingsSecrets(input);
    expect(input.smtpPass).toBe("hunter2");
    expect(redacted).not.toBe(input);
  });

  it("only lists secret keys that actually exist in the settings schema", () => {
    const shape = settingsSchema.shape as Record<string, unknown>;
    for (const key of SECRET_SETTING_KEYS) {
      expect(shape).toHaveProperty(key);
    }
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

  it("blocks when month-to-date cost reaches the monthly limit (issue #413)", () => {
    // Daily limit stays off (0), so only the monthly gate can trip here.
    saveSettings({ monthlyCostLimitUsd: 50 }, db);
    db.insert(jobs)
      .values({
        repoId,
        issueNumber: 1,
        status: "merged",
        startedAt: Math.floor(Date.now() / 1000),
        costUsd: 60,
      })
      .run();
    expect(jobsAllowed(db)).toEqual({ allowed: false, reason: "cost_limit" });
  });

  it("allows when month-to-date is under the monthly limit (issue #413)", () => {
    saveSettings({ monthlyCostLimitUsd: 500 }, db);
    db.insert(jobs)
      .values({
        repoId,
        issueNumber: 1,
        startedAt: Math.floor(Date.now() / 1000),
        costUsd: 20,
      })
      .run();
    expect(jobsAllowed(db).allowed).toBe(true);
  });

  it("treats a monthly cost limit of 0 as unlimited (issue #413)", () => {
    saveSettings({ monthlyCostLimitUsd: 0 }, db);
    db.insert(jobs)
      .values({
        repoId,
        issueNumber: 1,
        startedAt: Math.floor(Date.now() / 1000),
        costUsd: 9999,
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

  it("blocks when the repo's month-to-date cost hits its monthly limit (issue #413)", () => {
    const repo = addRepo({ path: "/rm1", name: "rm1", monthlyCostLimitUsd: 50 }, db);
    db.insert(jobs)
      .values({
        repoId: repo.id,
        issueNumber: 1,
        startedAt: Math.floor(Date.now() / 1000),
        costUsd: 60,
      })
      .run();
    const gate = repoJobsAllowed(repo.id, db);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe("repo_cost_limit");
  });

  it("allows below the repo monthly limit (issue #413)", () => {
    const repo = addRepo({ path: "/rm2", name: "rm2", monthlyCostLimitUsd: 50 }, db);
    expect(repoJobsAllowed(repo.id, db).allowed).toBe(true);
  });

  it("treats a repo monthly cost limit of 0 as unlimited (issue #413)", () => {
    const repo = addRepo({ path: "/rm3", name: "rm3", monthlyCostLimitUsd: 0 }, db);
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
