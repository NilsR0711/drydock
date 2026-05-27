import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

export const RETENTION_DAYS = 7;
const BACKUP_PREFIX = "drydock-";

/**
 * Back up the SQLite database into `backupDir` with a timestamped name and
 * prune backups older than RETENTION_DAYS (SPEC §8). Returns the new backup
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
  now: Date = new Date(),
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

  const cutoff = now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const file of readdirSync(backupDir)) {
    if (!file.startsWith(BACKUP_PREFIX)) continue;
    const full = join(backupDir, file);
    if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
  }
  return dest;
}
