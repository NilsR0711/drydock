import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

export const RETENTION_DAYS = 7;
const BACKUP_PREFIX = "drydock-";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface RunBackupOptions {
  /**
   * Prune backups older than this many days after writing the new one. Defaults
   * to RETENTION_DAYS. A value of `0` (or negative) disables pruning entirely,
   * so the caller keeps every snapshot — the manual CLI path relies on this.
   */
  retentionDays?: number;
  /** Injectable clock for deterministic tests. */
  now?: Date;
}

/**
 * Back up the SQLite database into `backupDir` with a timestamped name and
 * prune backups older than `retentionDays` (SPEC §8). Returns the new backup
 * path, or null if the source DB does not exist yet.
 *
 * Uses better-sqlite3's native `.backup()` API instead of a raw file copy so
 * the backup is internally consistent even while the DB runs in WAL mode
 * (a plain copy of the `.db` file would miss the `-wal`/`-shm` sidecars and
 * could capture a torn state).
 */
export async function runBackup(
  dbPath: string,
  backupDir: string,
  { retentionDays = RETENTION_DAYS, now = new Date() }: RunBackupOptions = {},
): Promise<string | null> {
  if (!existsSync(dbPath)) return null;
  mkdirSync(backupDir, { recursive: true });

  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const dest = join(backupDir, `${BACKUP_PREFIX}${stamp}.db`);

  const db = new Database(dbPath, { readonly: true });
  try {
    await db.backup(dest);
  } finally {
    db.close();
  }

  // retentionDays <= 0 disables pruning: keep every snapshot. Only prune with a
  // positive window so a caller can never accidentally delete every backup.
  if (retentionDays > 0) {
    const cutoff = now.getTime() - retentionDays * MS_PER_DAY;
    for (const file of readdirSync(backupDir)) {
      if (!file.startsWith(BACKUP_PREFIX)) continue;
      const full = join(backupDir, file);
      if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
    }
  }
  return dest;
}

/**
 * The most recent backup snapshot in `backupDir`, or null when the directory is
 * absent or holds no `drydock-*.db` files. Monitoring surfaces (`drydock doctor`,
 * `/api/health`) use it to catch a scheduled sweep that stopped writing.
 */
export function latestBackup(backupDir: string): { path: string; mtimeMs: number } | null {
  let files: string[];
  try {
    files = readdirSync(backupDir);
  } catch {
    return null; // directory does not exist yet (fresh install)
  }
  let latest: { path: string; mtimeMs: number } | null = null;
  for (const file of files) {
    if (!file.startsWith(BACKUP_PREFIX)) continue;
    const full = join(backupDir, file);
    const { mtimeMs } = statSync(full);
    if (!latest || mtimeMs > latest.mtimeMs) latest = { path: full, mtimeMs };
  }
  return latest;
}
