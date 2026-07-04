import { dirname, join } from "node:path";
import { type DB, getDb, resolveDbPath } from "@/lib/db/client";
import { logError } from "@/lib/log/logger";
import { getSettings } from "@/lib/settings/service";
import { runBackup } from "./backup";

/** Backup snapshots live alongside the database, in `<db dir>/backups`. */
export function backupDirFor(dbPath: string): string {
  return join(dirname(dbPath), "backups");
}

export interface BackupSweepDeps {
  /** Settings source; defaults to the process DB. Injectable for tests. */
  db?: DB;
  /** Database to snapshot; defaults to the resolved process DB path. */
  dbPath?: string;
  /** Injectable clock for deterministic tests. */
  now?: Date;
  /** Where the "wrote a snapshot" line goes; defaults to console.log. */
  log?: (line: string) => void;
}

export interface BackupSweepResult {
  /** The snapshot written this run, or null when none was (disabled/no DB). */
  dest: string | null;
  /** True when the sweep is turned off via `backupRetentionDays = 0`. */
  disabled?: boolean;
}

/**
 * Perform one backup sweep: honor the `backupRetentionDays` setting, write a
 * WAL-safe snapshot into `<data dir>/backups`, and prune snapshots past the
 * window. A retention of 0 disables the sweep — nothing is written. Reused by
 * the orchestrator's scheduler (ADR 042, issue #411); kept side-effect-light so
 * the schedule can drive it and tests can call it directly.
 */
export async function backupSweep(deps: BackupSweepDeps = {}): Promise<BackupSweepResult> {
  const db = deps.db ?? getDb();
  const retentionDays = getSettings(db).backupRetentionDays;
  if (retentionDays <= 0) return { dest: null, disabled: true };

  const dbPath = deps.dbPath ?? resolveDbPath();
  const dest = await runBackup(dbPath, backupDirFor(dbPath), { retentionDays, now: deps.now });
  if (dest) (deps.log ?? console.log)(`[orchestrator] backed up database → ${dest}`);
  return { dest };
}

/** Once at startup, then daily — the same cadence as the log-retention sweep. */
export const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface StartBackupSweepDeps {
  /** The work each tick runs; defaults to a real `backupSweep()`. */
  sweep?: () => Promise<unknown>;
  /** Milliseconds between sweeps; defaults to BACKUP_INTERVAL_MS. */
  intervalMs?: number;
  /** Failure handler; defaults to logging without crashing the orchestrator. */
  onError?: (err: unknown) => void;
}

/**
 * Schedule the backup sweep: run once immediately, then every `intervalMs`.
 * Mirrors `startPruneSweep` — failures are reported but never fatal, and the
 * timer is `unref`'d so it cannot keep the process alive. Returns a stop
 * function that cancels further sweeps.
 */
export function startBackupSweep(deps: StartBackupSweepDeps = {}): () => void {
  const sweep = deps.sweep ?? (() => backupSweep());
  const onError = deps.onError ?? ((err) => logError("[orchestrator] backup sweep failed", err));
  const run = () => {
    // Invoke synchronously so the first sweep starts at startup; a synchronous
    // throw and an async rejection both route to onError, never past this call.
    try {
      Promise.resolve(sweep()).catch(onError);
    } catch (err) {
      onError(err);
    }
  };
  run();
  const timer = setInterval(run, deps.intervalMs ?? BACKUP_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
