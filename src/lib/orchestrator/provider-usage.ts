import { eq } from "drizzle-orm";
import type { z } from "zod";
import { type ClaudeUsageReading, usageReadingSchema } from "@/lib/agents/claude-usage";
import {
  type CodexUsageReading,
  type CodexUsageSnapshot,
  codexSnapshotSchema,
  snapshotFromReading,
} from "@/lib/agents/codex-usage";
import { type DB, getDb } from "@/lib/db/client";
import { settings } from "@/lib/db/schema";

/**
 * Proactive provider-usage snapshots (issues #188/#189). Each provider's last
 * known quota state is stored in the settings key-value table under
 * `provider_usage:<agent>` — the same per-agent pattern the reactive
 * `provider_limit:<agent>` latch uses — so it survives a process restart and
 * can be streamed to the dashboard. Validated on read; a corrupt row reads as
 * "no reading". The two providers report differently (Claude a qualitative
 * status, Codex structured percentages), so each persists its own shape; the
 * key/upsert plumbing is shared below.
 */

const keyFor = (agent: string) => `provider_usage:${agent}`;
const nowSec = () => Math.floor(Date.now() / 1000);

/** Read and validate the stored reading for `agent`, or undefined if absent/corrupt. */
function readUsage<T>(agent: string, schema: z.ZodType<T>, db: DB): T | undefined {
  const row = db
    .select()
    .from(settings)
    .where(eq(settings.key, keyFor(agent)))
    .get();
  if (!row) return undefined;
  try {
    return schema.parse(JSON.parse(row.value));
  } catch {
    return undefined;
  }
}

/**
 * Persist `value` for `agent`, replacing any prior reading. Uses an atomic
 * upsert: parallel sessions can finish and write the same key at once, and a
 * read-then-write would race two inserts into a duplicate-key failure.
 */
function writeUsage(agent: string, value: unknown, db: DB): void {
  const serialized = JSON.stringify(value);
  db.insert(settings)
    .values({ key: keyFor(agent), value: serialized })
    .onConflictDoUpdate({ target: settings.key, set: { value: serialized } })
    .run();
}

// ---- Claude (issue #188): qualitative subscription-window reading ----------

/** The persisted Claude usage reading for `agent`, or undefined when absent/corrupt. */
export function getProviderUsage(agent: string, db: DB = getDb()): ClaudeUsageReading | undefined {
  return readUsage(agent, usageReadingSchema, db);
}

/** Persist the latest Claude usage reading for `agent`, replacing any prior value. */
export function saveProviderUsage(
  agent: string,
  reading: ClaudeUsageReading,
  db: DB = getDb(),
): void {
  writeUsage(agent, reading, db);
}

// ---- Codex (issue #189): quantitative rate-limit snapshot ------------------

/** The persisted Codex usage snapshot, or undefined when absent/corrupt. */
export function getCodexUsage(db: DB = getDb()): CodexUsageSnapshot | undefined {
  return readUsage("codex", codexSnapshotSchema, db);
}

/**
 * Persist a freshly-captured Codex reading, anchoring its relative reset offsets
 * to `now` so the countdowns stay correct across reloads. Returns the snapshot.
 */
export function recordCodexUsage(
  reading: CodexUsageReading,
  db: DB = getDb(),
  now: number = nowSec(),
): CodexUsageSnapshot {
  const snapshot = snapshotFromReading(reading, now);
  writeUsage("codex", snapshot, db);
  return snapshot;
}
