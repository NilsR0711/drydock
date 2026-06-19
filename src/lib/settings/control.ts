import { type DB, getDb } from "@/lib/db/client";
import { notifyPauseTransition } from "@/lib/notify/lifecycle";
import { getSettings, type Settings, saveSettings } from "./service";

/**
 * Programmatic global pause/resume (issue #292). Extracted from
 * {@link togglePauseAction} so the desktop tray's HTTP control endpoint and the
 * dashboard's Server Action share one implementation — including the
 * resume→paused edge notification (issue #22). Server-Action-only concerns
 * (Next.js cache revalidation) stay in the action; this layer is the pure
 * state transition and is unit-testable without a request context.
 */
export async function setPaused(
  paused: boolean,
  db: DB = getDb(),
  notify: typeof notifyPauseTransition = notifyPauseTransition,
): Promise<Settings> {
  const before = getSettings(db);
  const merged = saveSettings({ paused }, db);
  await notify(before.paused, merged.paused, db);
  return merged;
}

/**
 * Programmatic drain-mode toggle (issue #292). Drain is a DB-backed flag that
 * stops the driver loop from picking up new work while letting in-flight jobs
 * finish (see settings schema). No edge notification today — unlike pause it has
 * no dedicated notification event — so this is a thin, symmetric wrapper the
 * tray and any future UI can share.
 */
export async function setDraining(draining: boolean, db: DB = getDb()): Promise<Settings> {
  return saveSettings({ draining }, db);
}
