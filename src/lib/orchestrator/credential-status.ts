import { eq } from "drizzle-orm";
import { z } from "zod";
import { type DB, getDb } from "@/lib/db/client";
import { settings } from "@/lib/db/schema";

/**
 * DB-persisted result of the credential watchdog's last probe round (issue
 * #177). Lives in the settings key-value table under its own key — like the
 * provider-limit latch — so it survives restarts and is readable from every
 * process and render path. Kept free of settings/service imports so
 * `jobsAllowed()` can consume it without an import cycle.
 */

export const CREDENTIAL_STATUS_KEY = "credential_watchdog";

/** One credential target the watchdog found unhealthy. */
export interface CredentialFailure {
  /** Stable id, e.g. "github", "gitlab:https://gitlab.example.com", "agent:claude". */
  target: string;
  /** Human-readable name for the banner/notification, e.g. "GitHub CLI auth". */
  label: string;
  /** Actionable failure message (secrets already redacted by the prober). */
  message: string;
}

export interface CredentialStatus {
  /** Epoch seconds of the probe round that produced this status. */
  checkedAt: number;
  /** Empty when every probed credential is healthy. */
  failures: CredentialFailure[];
}

const failureSchema = z.object({
  target: z.string(),
  label: z.string(),
  message: z.string(),
});

const statusSchema = z.object({
  checkedAt: z.number(),
  failures: z.array(failureSchema),
});

/** The persisted watchdog status, or undefined when absent/corrupt. */
export function getCredentialStatus(db: DB = getDb()): CredentialStatus | undefined {
  const row = db.select().from(settings).where(eq(settings.key, CREDENTIAL_STATUS_KEY)).get();
  if (!row) return undefined;
  try {
    return statusSchema.parse(JSON.parse(row.value));
  } catch {
    return undefined;
  }
}

/**
 * Persist the latest probe round, replacing any previous status. An atomic
 * upsert: the MCP server runs as its own process, so a select-then-insert
 * could race a concurrent writer on the same key.
 */
export function saveCredentialStatus(status: CredentialStatus, db: DB = getDb()): void {
  const value = JSON.stringify(status);
  db.insert(settings)
    .values({ key: CREDENTIAL_STATUS_KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
}

/**
 * The currently known credential failures, empty when healthy or never probed.
 * "Never probed" must read as healthy: a fresh install without a single probe
 * round must not gate the queue.
 */
export function getCredentialFailures(db: DB = getDb()): CredentialFailure[] {
  return getCredentialStatus(db)?.failures ?? [];
}
