import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RETENTION_DAYS, runBackup } from "@/lib/backup/backup";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ac-backup-"));
}

/** Create a valid SQLite DB (WAL mode) with a row so backups have real content. */
function makeDb(dbPath: string): void {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  db.prepare("INSERT INTO t (v) VALUES (?)").run("hello");
  db.close();
}

describe("runBackup", () => {
  it("returns null when the DB does not exist", async () => {
    expect(await runBackup(join(tmp(), "missing.db"), tmp())).toBeNull();
  });

  it("creates a consistent, restorable backup of the DB", async () => {
    const root = tmp();
    const dbPath = join(root, "drydock.db");
    makeDb(dbPath);
    const backupDir = join(root, "backups");

    const dest = await runBackup(dbPath, backupDir);
    expect(dest).not.toBeNull();
    expect(existsSync(dest as string)).toBe(true);
    expect(readdirSync(backupDir)).toHaveLength(1);

    // The backup is a valid SQLite file containing the original data.
    const restored = new Database(dest as string, { readonly: true });
    const row = restored.prepare("SELECT v FROM t WHERE id = 1").get() as { v: string };
    restored.close();
    expect(row.v).toBe("hello");
  });

  it("prunes backups older than the retention window", async () => {
    const root = tmp();
    const dbPath = join(root, "drydock.db");
    makeDb(dbPath);
    const backupDir = join(root, "backups");

    // create an old backup and age it past retention
    mkdirSync(backupDir, { recursive: true });
    const old = join(backupDir, "drydock-old.db");
    makeDb(old);
    const ancient = (Date.now() - (RETENTION_DAYS + 2) * 86400_000) / 1000;
    utimesSync(old, ancient, ancient);

    await runBackup(dbPath, backupDir);
    expect(existsSync(old)).toBe(false);
  });
});
