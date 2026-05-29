import { eq } from "drizzle-orm";
import { z } from "zod";
import { type DB, getDb } from "@/lib/db/client";
import { todayCost } from "@/lib/db/cost-queries";
import { repos, settings } from "@/lib/db/schema";
import { NOTIFICATION_EVENTS } from "@/lib/notify/events";

export const settingsSchema = z.object({
  paused: z.boolean().default(false),
  dailyCostLimitUsd: z.number().nonnegative().default(10),
  pollIntervalSec: z.number().int().positive().default(30),
  maxTurns: z.number().int().positive().default(40),
  // Hard wall-clock timeout per agent session in minutes (issue #47). A hung
  // agent (network stall, MCP deadlock, stdin prompt) is aborted after this so
  // it never holds a job slot forever. A per-repo override may shorten/extend it.
  maxJobMinutes: z.number().int().positive().default(30),
  // Hard wall-clock budget for CI to start and settle after a PR is opened
  // (issue #52). If required checks sit pending/queued past this, the babysitter
  // stops polling and escalates the job to needs_human instead of looping
  // forever. A per-repo override may shorten/extend it.
  maxCiWaitMinutes: z.number().int().positive().default(60),
  // Per-job USD cost ceiling (issue #57). When a single session's accumulated
  // cost crosses this, the agent is aborted mid-stream (SIGTERM → SIGKILL) and
  // the job escalates to needs_human, bounding the blast radius of one runaway
  // session that could otherwise drain the whole daily budget by itself. 0 is
  // off (no ceiling) — the default when unset. A per-repo override may tighten
  // or relax it.
  maxJobCostUsd: z.number().nonnegative().default(0),
  // Global kill-switch for opt-in release management (issue #59, ADR 028). Off by
  // default; both this and a repo's own `releaseEnabled` must be on for the
  // release pipeline to run for that repo. Cutting a public release is hard to
  // reverse, so the feature ships gated and previewable.
  releaseManagementEnabled: z.boolean().default(false),
  defaultModel: z.string().default("claude-opus-4-8"),
  defaultAgent: z.enum(["claude", "codex"]).default("claude"),
  claudePath: z.string().default("claude"),
  codexPath: z.string().default("codex"),
  ghPath: z.string().default("gh"),
  maxParallelJobs: z.number().int().positive().default(3),
  telegramBotToken: z.string().default(""),
  telegramChatId: z.string().default(""),
  // External notification channels (issue #22). Each is optional and
  // configured independently; an empty value disables that channel.
  slackWebhookUrl: z.string().default(""),
  smtpHost: z.string().default(""),
  smtpPort: z.number().int().positive().default(587),
  smtpUser: z.string().default(""),
  smtpPass: z.string().default(""),
  emailFrom: z.string().default(""),
  emailTo: z.string().default(""),
  // Lifecycle events that trigger a notification on every configured channel.
  notifyEvents: z.array(z.enum(NOTIFICATION_EVENTS)).default([...NOTIFICATION_EVENTS]),
  // Finished jobs older than this many days have their verbose job_events
  // pruned (their cost summary rows are kept). See issue #24.
  retentionDays: z.number().int().positive().default(30),
});
export type Settings = z.infer<typeof settingsSchema>;

const KEY = "global";

export function getSettings(db: DB = getDb()): Settings {
  const row = db.select().from(settings).where(eq(settings.key, KEY)).get();
  if (!row) return settingsSchema.parse({});
  try {
    return settingsSchema.parse(JSON.parse(row.value));
  } catch {
    return settingsSchema.parse({});
  }
}

export function saveSettings(patch: Partial<Settings>, db: DB = getDb()): Settings {
  const merged = settingsSchema.parse({ ...getSettings(db), ...patch });
  const value = JSON.stringify(merged);
  const existing = db.select().from(settings).where(eq(settings.key, KEY)).get();
  if (existing) {
    db.update(settings).set({ value }).where(eq(settings.key, KEY)).run();
  } else {
    db.insert(settings).values({ key: KEY, value }).run();
  }
  return merged;
}

export interface GateResult {
  allowed: boolean;
  reason?: "paused" | "cost_limit" | "repo_cost_limit";
}

/** Whether the driver loop may start new jobs right now (SPEC §6.1). */
export function jobsAllowed(db: DB = getDb()): GateResult {
  const s = getSettings(db);
  if (s.paused) return { allowed: false, reason: "paused" };
  if (todayCost(db) >= s.dailyCostLimitUsd) return { allowed: false, reason: "cost_limit" };
  return { allowed: true };
}

/** Whether new jobs may start for a specific repo (its own daily limit). */
export function repoJobsAllowed(repoId: number, db: DB = getDb()): GateResult {
  const repo = db.select().from(repos).where(eq(repos.id, repoId)).get();
  if (!repo) return { allowed: false, reason: "repo_cost_limit" };
  if (todayCost(db, repoId) >= repo.dailyCostLimitUsd) {
    return { allowed: false, reason: "repo_cost_limit" };
  }
  return { allowed: true };
}
