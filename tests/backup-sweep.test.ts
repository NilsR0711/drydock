import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backupSweep, startBackupSweep } from "@/lib/backup/sweep";
import { createDb, type DB } from "@/lib/db/client";
import { saveSettings } from "@/lib/settings/service";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ac-backup-sweep-"));
}

/** Create a valid SQLite DB (WAL mode) with a row so backups have real content. */
function makeDb(dbPath: string): void {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  db.prepare("INSERT INTO t (v) VALUES (?)").run("hello");
  db.close();
}

let settingsDb: DB;
beforeEach(() => {
  settingsDb = createDb(":memory:");
});

describe("backupSweep", () => {
  it("writes a snapshot and prunes past the configured retention window", async () => {
    const root = tmp();
    const dbPath = join(root, "drydock.db");
    makeDb(dbPath);
    const backupDir = join(root, "backups");
    mkdirSync(backupDir, { recursive: true });

    // A prior backup aged past a 2-day window must be pruned by the sweep.
    const stale = join(backupDir, "drydock-stale.db");
    makeDb(stale);
    const aged = (Date.now() - 3 * 86400_000) / 1000;
    utimesSync(stale, aged, aged);

    saveSettings({ backupRetentionDays: 2 }, settingsDb);
    const result = await backupSweep({ db: settingsDb, dbPath, log: () => {} });

    expect(result.disabled).toBeFalsy();
    expect(result.dest).not.toBeNull();
    expect(existsSync(result.dest as string)).toBe(true);
    expect(existsSync(stale)).toBe(false);
    // Only the fresh snapshot remains in the backups directory.
    expect(readdirSync(backupDir).filter((f) => f.startsWith("drydock-"))).toHaveLength(1);
  });

  it("does nothing when backup retention is 0 (opt-out)", async () => {
    const root = tmp();
    const dbPath = join(root, "drydock.db");
    makeDb(dbPath);

    saveSettings({ backupRetentionDays: 0 }, settingsDb);
    const result = await backupSweep({ db: settingsDb, dbPath, log: () => {} });

    expect(result.disabled).toBe(true);
    expect(result.dest).toBeNull();
    // No backups directory is created when the sweep is disabled.
    expect(existsSync(join(root, "backups"))).toBe(false);
  });

  it("returns null without writing when the database does not exist yet", async () => {
    const root = tmp();
    const result = await backupSweep({
      db: settingsDb,
      dbPath: join(root, "missing.db"),
      log: () => {},
    });
    expect(result.dest).toBeNull();
    expect(existsSync(join(root, "backups"))).toBe(false);
  });
});

describe("startBackupSweep", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs once immediately and then every interval", async () => {
    vi.useFakeTimers();
    const sweep = vi.fn().mockResolvedValue({ dest: null });

    const stop = startBackupSweep({ sweep, intervalMs: 1000 });
    expect(sweep).toHaveBeenCalledTimes(1); // immediate run at startup

    await vi.advanceTimersByTimeAsync(1000);
    expect(sweep).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sweep).toHaveBeenCalledTimes(3);

    stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(sweep).toHaveBeenCalledTimes(3); // no further runs after stop
  });

  it("never throws when a sweep rejects; it reports via onError", async () => {
    vi.useFakeTimers();
    const boom = new Error("backup failed");
    const sweep = vi.fn().mockRejectedValue(boom);
    const onError = vi.fn();

    expect(() => startBackupSweep({ sweep, intervalMs: 1000, onError })).not.toThrow();
    await vi.advanceTimersByTimeAsync(0); // let the immediate run's rejection settle
    expect(onError).toHaveBeenCalledWith(boom);
  });
});
