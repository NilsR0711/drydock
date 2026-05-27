import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export const RETENTION_DAYS = 7;
const BACKUP_PREFIX = "drydock-";

/**
 * Copy the SQLite file into `backupDir` with a timestamped name and prune
 * backups older than RETENTION_DAYS (SPEC §8). Returns the new backup path,
 * or null if the source DB does not exist yet.
 */
export function runBackup(
  dbPath: string,
  backupDir: string,
  now: Date = new Date(),
): string | null {
  if (!existsSync(dbPath)) return null;
  mkdirSync(backupDir, { recursive: true });

  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const dest = join(backupDir, `${BACKUP_PREFIX}${stamp}.db`);
  copyFileSync(dbPath, dest);

  const cutoff = now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const file of readdirSync(backupDir)) {
    if (!file.startsWith(BACKUP_PREFIX)) continue;
    const full = join(backupDir, file);
    if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
  }
  return dest;
}
