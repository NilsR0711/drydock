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
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { latestBackup, RETENTION_DAYS, runBackup } from "@/lib/backup/backup";

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

  it("honors a custom retention window when pruning", async () => {
    const root = tmp();
    const dbPath = join(root, "drydock.db");
    makeDb(dbPath);
    const backupDir = join(root, "backups");
    mkdirSync(backupDir, { recursive: true });

    // Two prior backups: one 3 days old, one 1 day old. A 2-day window prunes
    // only the older one — the default 7-day window would keep both.
    const threeDays = join(backupDir, "drydock-three.db");
    const oneDay = join(backupDir, "drydock-one.db");
    makeDb(threeDays);
    makeDb(oneDay);
    const agedThree = (Date.now() - 3 * 86400_000) / 1000;
    const agedOne = (Date.now() - 1 * 86400_000) / 1000;
    utimesSync(threeDays, agedThree, agedThree);
    utimesSync(oneDay, agedOne, agedOne);

    await runBackup(dbPath, backupDir, { retentionDays: 2 });

    expect(existsSync(threeDays)).toBe(false);
    expect(existsSync(oneDay)).toBe(true);
  });

  it("keeps every backup when the retention window is zero (pruning disabled)", async () => {
    const root = tmp();
    const dbPath = join(root, "drydock.db");
    makeDb(dbPath);
    const backupDir = join(root, "backups");
    mkdirSync(backupDir, { recursive: true });

    const ancientFile = join(backupDir, "drydock-ancient.db");
    makeDb(ancientFile);
    const ancient = (Date.now() - 100 * 86400_000) / 1000;
    utimesSync(ancientFile, ancient, ancient);

    await runBackup(dbPath, backupDir, { retentionDays: 0 });

    expect(existsSync(ancientFile)).toBe(true);
  });
});

describe("latestBackup", () => {
  it("returns null when the backup directory does not exist", () => {
    expect(latestBackup(join(tmp(), "backups"))).toBeNull();
  });

  it("returns null when the directory holds no drydock backups", () => {
    const dir = tmp();
    writeFileSync(join(dir, "notes.txt"), "not a backup");
    writeFileSync(join(dir, "other.db"), "unrelated");
    expect(latestBackup(dir)).toBeNull();
  });

  it("returns the newest drydock backup by modification time", () => {
    const dir = tmp();
    const older = join(dir, "drydock-older.db");
    const newer = join(dir, "drydock-newer.db");
    writeFileSync(older, "a");
    writeFileSync(newer, "b");
    const oldTime = (Date.now() - 5 * 86400_000) / 1000;
    const newTime = Date.now() / 1000;
    utimesSync(older, oldTime, oldTime);
    utimesSync(newer, newTime, newTime);

    const latest = latestBackup(dir);
    expect(latest?.path).toBe(newer);
    expect(latest?.mtimeMs).toBeCloseTo(newTime * 1000, -2);
  });
});
