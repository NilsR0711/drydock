import { eq } from "drizzle-orm";
import { z } from "zod";
import { type DB, getDb } from "@/lib/db/client";
import { todayCost } from "@/lib/db/cost-queries";
import { repos, settings } from "@/lib/db/schema";

export const settingsSchema = z.object({
  paused: z.boolean().default(false),
  dailyCostLimitUsd: z.number().nonnegative().default(10),
  pollIntervalSec: z.number().int().positive().default(30),
  maxTurns: z.number().int().positive().default(40),
  defaultModel: z.string().default("claude-opus-4-7"),
  claudePath: z.string().default("claude"),
  ghPath: z.string().default("gh"),
  maxParallelJobs: z.number().int().positive().default(3),
  telegramBotToken: z.string().default(""),
  telegramChatId: z.string().default(""),
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
