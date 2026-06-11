import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readLockState,
  resolveBackupTarget,
  resolveLockPath,
  runBackupCommand,
  runRestoreCommand,
  timestampedBackupName,
} from "../bin/ops.mjs";

/** Collects command output lines so assertions can inspect them. */
function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    log: (line: string) => out.push(line),
    error: (line: string) => err.push(line),
  };
}

/** Create a real SQLite DB in WAL mode with one marker row. */
function createDb(path: string, marker: string): void {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE IF NOT EXISTS marker (value TEXT NOT NULL)");
  db.prepare("INSERT INTO marker (value) VALUES (?)").run(marker);
  db.close();
}

function readMarker(path: string): string {
  const db = new Database(path, { readonly: true });
  try {
    const row = db.prepare("SELECT value FROM marker LIMIT 1").get() as { value: string };
    return row.value;
  } finally {
    db.close();
  }
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "drydock-ops-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveLockPath", () => {
  it("defaults to ~/.drydock/instance.lock", () => {
    expect(resolveLockPath({ env: {}, home: "/home/jane" })).toBe(
      "/home/jane/.drydock/instance.lock",
    );
  });

  it("honours the DRYDOCK_HOME override used by the server's lock", () => {
    expect(resolveLockPath({ env: { DRYDOCK_HOME: "/data/dd" }, home: "/home/jane" })).toBe(
      "/data/dd/instance.lock",
    );
  });
});

describe("readLockState", () => {
  it("reports free when no lock file exists", () => {
    expect(readLockState(join(dir, "instance.lock"))).toEqual({ state: "free" });
  });

  it("reports held with the pid when the lock holder is alive", () => {
    const path = join(dir, "instance.lock");
    writeFileSync(path, JSON.stringify({ pid: 12345, ts: 1 }));
    expect(readLockState(path, { pidAlive: () => true })).toEqual({ state: "held", pid: 12345 });
  });

  it("reports stale when the lock holder is dead", () => {
    const path = join(dir, "instance.lock");
    writeFileSync(path, JSON.stringify({ pid: 12345, ts: 1 }));
    expect(readLockState(path, { pidAlive: () => false })).toEqual({ state: "stale", pid: 12345 });
  });

  it("treats a corrupt lock file as stale", () => {
    const path = join(dir, "instance.lock");
    writeFileSync(path, "not json");
    expect(readLockState(path, { pidAlive: () => true })).toEqual({ state: "stale" });
  });

  it("reports unknown (fail-closed) when the lock file exists but cannot be read", () => {
    // A directory as the lock path makes readFileSync throw EISDIR — a
    // portable stand-in for any non-ENOENT read error such as EACCES/EIO.
    expect(readLockState(dir, { pidAlive: () => true })).toEqual({ state: "unknown" });
  });
});

describe("timestampedBackupName", () => {
  it("formats the timestamp like the server-side backup job", () => {
    const now = new Date("2026-06-12T03:04:05.678Z");
    expect(timestampedBackupName(now)).toBe("drydock-2026-06-12T03-04-05-678Z.db");
  });
});

describe("resolveBackupTarget", () => {
  const now = new Date("2026-06-12T03:04:05.678Z");

  it("defaults to a timestamped file under <dataDir>/backups", () => {
    expect(resolveBackupTarget(undefined, { dataDir: "/data/dd", now })).toBe(
      join("/data/dd", "backups", "drydock-2026-06-12T03-04-05-678Z.db"),
    );
  });

  it("places a timestamped file inside an existing directory argument", () => {
    expect(resolveBackupTarget(dir, { dataDir: "/data/dd", now })).toBe(
      join(dir, "drydock-2026-06-12T03-04-05-678Z.db"),
    );
  });

  it("uses an explicit file path verbatim", () => {
    const target = join(dir, "my-backup.db");
    expect(resolveBackupTarget(target, { dataDir: "/data/dd", now })).toBe(target);
  });
});

describe("runBackupCommand", () => {
  it("writes a consistent snapshot of a WAL-mode database", async () => {
    const dbPath = join(dir, "drydock.db");
    createDb(dbPath, "hello");
    const target = join(dir, "out", "snap.db");
    const io = captureIo();

    const code = await runBackupCommand(target, { dbPath, dataDir: dir, ...io });

    expect(code).toBe(0);
    expect(readMarker(target)).toBe("hello");
    expect(io.out.join("\n")).toContain(target);
  });

  it("captures rows that only live in the WAL sidecar", async () => {
    const dbPath = join(dir, "drydock.db");
    createDb(dbPath, "first");
    // Insert without checkpointing so the row sits in the -wal file.
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("wal_autocheckpoint = 0");
    db.prepare("INSERT INTO marker (value) VALUES (?)").run("in-wal");
    const target = join(dir, "snap.db");
    const io = captureIo();

    const code = await runBackupCommand(target, { dbPath, dataDir: dir, ...io });
    db.close();

    expect(code).toBe(0);
    const snap = new Database(target, { readonly: true });
    const rows = snap.prepare("SELECT value FROM marker").all() as { value: string }[];
    snap.close();
    expect(rows.map((r) => r.value)).toContain("in-wal");
  });

  it("defaults to a timestamped file under <dataDir>/backups", async () => {
    const dbPath = join(dir, "drydock.db");
    createDb(dbPath, "hello");
    const io = captureIo();

    const code = await runBackupCommand(undefined, {
      dbPath,
      dataDir: dir,
      now: new Date("2026-06-12T03:04:05.678Z"),
      ...io,
    });

    expect(code).toBe(0);
    const expected = join(dir, "backups", "drydock-2026-06-12T03-04-05-678Z.db");
    expect(existsSync(expected)).toBe(true);
    expect(readMarker(expected)).toBe("hello");
  });

  it("fails when the database does not exist yet", async () => {
    const io = captureIo();
    const code = await runBackupCommand(undefined, {
      dbPath: join(dir, "missing.db"),
      dataDir: dir,
      ...io,
    });
    expect(code).toBe(1);
    expect(io.err.join("\n")).toMatch(/no database/i);
  });

  it("refuses to overwrite an existing target file", async () => {
    const dbPath = join(dir, "drydock.db");
    createDb(dbPath, "hello");
    const target = join(dir, "existing.db");
    writeFileSync(target, "precious bytes");
    const io = captureIo();

    const code = await runBackupCommand(target, { dbPath, dataDir: dir, ...io });

    expect(code).toBe(1);
    expect(readFileSync(target, "utf8")).toBe("precious bytes");
    expect(io.err.join("\n")).toMatch(/exists/i);
  });

  it("returns 1 instead of throwing when the source is not a readable database", async () => {
    const dbPath = join(dir, "not-a-db.db");
    writeFileSync(dbPath, "definitely not sqlite");
    const io = captureIo();

    const code = await runBackupCommand(join(dir, "snap.db"), { dbPath, dataDir: dir, ...io });

    expect(code).toBe(1);
    expect(io.err.join("\n")).toMatch(/backup failed/i);
  });
});

describe("runRestoreCommand", () => {
  it("replaces the database and removes stale WAL/SHM sidecars", async () => {
    const dbPath = join(dir, "drydock.db");
    createDb(dbPath, "old");
    // Fake leftover sidecars from a previous run; a restore must drop them so
    // SQLite cannot replay old WAL frames over the restored file.
    writeFileSync(`${dbPath}-wal`, "stale wal");
    writeFileSync(`${dbPath}-shm`, "stale shm");
    const backup = join(dir, "backup.db");
    createDb(backup, "restored");
    const io = captureIo();

    const code = await runRestoreCommand(backup, {
      dbPath,
      lockPath: join(dir, "instance.lock"),
      ...io,
    });

    expect(code).toBe(0);
    // Check the sidecars before reading the DB: opening a WAL-mode database
    // (even readonly) recreates fresh empty sidecar files.
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
    expect(readMarker(dbPath)).toBe("restored");
  });

  it("restores onto a machine that has no database yet", async () => {
    const backup = join(dir, "backup.db");
    createDb(backup, "fresh");
    const dbPath = join(dir, "data", "drydock.db");
    const io = captureIo();

    const code = await runRestoreCommand(backup, {
      dbPath,
      lockPath: join(dir, "instance.lock"),
      ...io,
    });

    expect(code).toBe(0);
    expect(readMarker(dbPath)).toBe("fresh");
  });

  it("refuses while a live drydock process holds the instance lock", async () => {
    const dbPath = join(dir, "drydock.db");
    createDb(dbPath, "old");
    const backup = join(dir, "backup.db");
    createDb(backup, "restored");
    const lockPath = join(dir, "instance.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: 4242, ts: 1 }));
    const io = captureIo();

    const code = await runRestoreCommand(backup, {
      dbPath,
      lockPath,
      pidAlive: () => true,
      ...io,
    });

    expect(code).toBe(1);
    expect(readMarker(dbPath)).toBe("old");
    expect(io.err.join("\n")).toMatch(/running/i);
  });

  it("proceeds when the lock is stale (dead pid)", async () => {
    const dbPath = join(dir, "drydock.db");
    createDb(dbPath, "old");
    const backup = join(dir, "backup.db");
    createDb(backup, "restored");
    const lockPath = join(dir, "instance.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: 4242, ts: 1 }));
    const io = captureIo();

    const code = await runRestoreCommand(backup, {
      dbPath,
      lockPath,
      pidAlive: () => false,
      ...io,
    });

    expect(code).toBe(0);
    expect(readMarker(dbPath)).toBe("restored");
  });

  it("fails when the backup file does not exist", async () => {
    const dbPath = join(dir, "drydock.db");
    createDb(dbPath, "old");
    const io = captureIo();

    const code = await runRestoreCommand(join(dir, "nope.db"), {
      dbPath,
      lockPath: join(dir, "instance.lock"),
      ...io,
    });

    expect(code).toBe(1);
    expect(readMarker(dbPath)).toBe("old");
  });

  it("rejects a file that is not a valid SQLite database", async () => {
    const dbPath = join(dir, "drydock.db");
    createDb(dbPath, "old");
    const bogus = join(dir, "bogus.db");
    writeFileSync(bogus, "definitely not sqlite");
    const io = captureIo();

    const code = await runRestoreCommand(bogus, {
      dbPath,
      lockPath: join(dir, "instance.lock"),
      ...io,
    });

    expect(code).toBe(1);
    expect(readMarker(dbPath)).toBe("old");
    expect(io.err.join("\n")).toMatch(/not a valid sqlite/i);
  });

  it("refuses (fail-closed) when the lock file exists but cannot be read", async () => {
    const dbPath = join(dir, "drydock.db");
    createDb(dbPath, "old");
    const backup = join(dir, "backup.db");
    createDb(backup, "restored");
    const io = captureIo();

    // The lock path points at a directory, so reading it fails with EISDIR —
    // an unknown lock state must block the restore, not bypass the guard.
    const code = await runRestoreCommand(backup, { dbPath, lockPath: dir, ...io });

    expect(code).toBe(1);
    expect(readMarker(dbPath)).toBe("old");
    expect(io.err.join("\n")).toMatch(/lock/i);
  });

  it("returns 1 instead of throwing when the target cannot be written", async () => {
    const backup = join(dir, "backup.db");
    createDb(backup, "restored");
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "a plain file where a directory is needed");
    const io = captureIo();

    const code = await runRestoreCommand(backup, {
      dbPath: join(blocker, "drydock.db"),
      lockPath: join(dir, "instance.lock"),
      ...io,
    });

    expect(code).toBe(1);
    expect(io.err.join("\n")).toMatch(/restore failed/i);
  });
});
