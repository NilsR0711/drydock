import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RETENTION_DAYS, runBackup } from "@/lib/backup/backup";
import { describe, expect, it } from "vitest";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ac-backup-"));
}

describe("runBackup", () => {
  it("returns null when the DB does not exist", () => {
    expect(runBackup(join(tmp(), "missing.db"), tmp())).toBeNull();
  });

  it("copies the DB into a timestamped backup file", () => {
    const root = tmp();
    const dbPath = join(root, "drydock.db");
    writeFileSync(dbPath, "sqlite-bytes");
    const backupDir = join(root, "backups");
    const dest = runBackup(dbPath, backupDir);
    expect(dest).not.toBeNull();
    expect(existsSync(dest as string)).toBe(true);
    expect(readdirSync(backupDir)).toHaveLength(1);
  });

  it("prunes backups older than the retention window", () => {
    const root = tmp();
    const dbPath = join(root, "drydock.db");
    writeFileSync(dbPath, "x");
    const backupDir = join(root, "backups");

    // create an old backup and age it past retention
    mkdirSync(backupDir, { recursive: true });
    const old = join(backupDir, "drydock-old.db");
    writeFileSync(old, "old");
    const ancient = (Date.now() - (RETENTION_DAYS + 2) * 86400_000) / 1000;
    utimesSync(old, ancient, ancient);

    runBackup(dbPath, backupDir);
    expect(existsSync(old)).toBe(false);
  });
});
