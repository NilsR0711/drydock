import { type DB, getDb } from "@/lib/db/client";
import { todayCost } from "@/lib/db/cost-queries";
import { settings } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";

export const settingsSchema = z.object({
  paused: z.boolean().default(false),
  dailyCostLimitUsd: z.number().nonnegative().default(10),
  pollIntervalSec: z.number().int().positive().default(30),
  maxTurns: z.number().int().positive().default(40),
  defaultModel: z.string().default("claude-sonnet-4-5"),
  claudePath: z.string().default("claude"),
  ghPath: z.string().default("gh"),
  maxParallelJobs: z.number().int().positive().default(3),
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
  reason?: "paused" | "cost_limit";
}

/** Whether the driver loop may start new jobs right now (SPEC §6.1). */
export function jobsAllowed(db: DB = getDb()): GateResult {
  const s = getSettings(db);
  if (s.paused) return { allowed: false, reason: "paused" };
  if (todayCost(db) >= s.dailyCostLimitUsd) return { allowed: false, reason: "cost_limit" };
  return { allowed: true };
}
