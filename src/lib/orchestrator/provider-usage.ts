import { eq } from "drizzle-orm";
import { type ClaudeUsageReading, usageReadingSchema } from "@/lib/agents/claude-usage";
import { type DB, getDb } from "@/lib/db/client";
import { settings } from "@/lib/db/schema";

/**
 * Proactive provider-usage snapshot (issue #188). Stored in the settings
 * key-value table under `provider_usage:<agent>` — the same per-agent pattern
 * the reactive `provider_limit:<agent>` latch uses — so the last known
 * subscription-window state survives a process restart and can be streamed to
 * the dashboard. Validated on read; a corrupt row reads as "no reading".
 */

const keyFor = (agent: string) => `provider_usage:${agent}`;

/** The persisted usage reading for `agent`, or undefined when absent/corrupt. */
export function getProviderUsage(agent: string, db: DB = getDb()): ClaudeUsageReading | undefined {
  const row = db
    .select()
    .from(settings)
    .where(eq(settings.key, keyFor(agent)))
    .get();
  if (!row) return undefined;
  try {
    return usageReadingSchema.parse(JSON.parse(row.value));
  } catch {
    return undefined;
  }
}

/** Persist the latest usage reading for `agent`, replacing any prior value. */
export function saveProviderUsage(
  agent: string,
  reading: ClaudeUsageReading,
  db: DB = getDb(),
): void {
  const key = keyFor(agent);
  const value = JSON.stringify(reading);
  const existing = db.select().from(settings).where(eq(settings.key, key)).get();
  if (existing) {
    db.update(settings).set({ value }).where(eq(settings.key, key)).run();
  } else {
    db.insert(settings).values({ key, value }).run();
  }
}
