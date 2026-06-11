// Ops subcommands for the packaged Drydock CLI (issue #176): backup/restore,
// doctor, and service install. Lives under bin/ (which ships in the npm
// tarball) as plain ESM with no build step, because the published package
// contains no src/ tree. Command functions never call process.exit — they
// return an exit code so they stay unit-testable; bin/drydock.mjs owns the
// process boundary.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Path of the single-instance lock the server holds while running. Mirrors the
 * server's `worktreeHome()` resolution (DRYDOCK_HOME ?? ~/.drydock) so the CLI
 * inspects the same file the orchestrator locks.
 *
 * @param {{ env?: Record<string, string | undefined>, home?: string }} [opts]
 */
export function resolveLockPath({ env = process.env, home = homedir() } = {}) {
  return join(env.DRYDOCK_HOME ?? join(home, ".drydock"), "instance.lock");
}

/** @param {number} pid */
function defaultPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Inspect the instance lock file: free (absent), held (live pid), or stale
 * (dead pid or unreadable content). Mirrors the staleness rules of the
 * server's `acquireInstanceLock`.
 *
 * @param {string} lockPath
 * @param {{ pidAlive?: (pid: number) => boolean }} [deps]
 * @returns {{ state: "free" | "held" | "stale", pid?: number }}
 */
export function readLockState(lockPath, { pidAlive = defaultPidAlive } = {}) {
  let raw;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch {
    return { state: "free" };
  }
  try {
    const { pid } = JSON.parse(raw);
    if (!Number.isInteger(pid)) return { state: "stale" };
    return pidAlive(pid) ? { state: "held", pid } : { state: "stale", pid };
  } catch {
    return { state: "stale" };
  }
}

/**
 * Timestamped backup filename, formatted exactly like the server-side backup
 * job so both kinds of snapshots sort and prune together.
 *
 * @param {Date} [now]
 */
export function timestampedBackupName(now = new Date()) {
  return `drydock-${now.toISOString().replace(/[:.]/g, "-")}.db`;
}

/**
 * Resolve where `drydock backup [path]` writes: no argument → timestamped file
 * under `<dataDir>/backups`; an existing directory → timestamped file inside
 * it; anything else is taken verbatim as the target file.
 *
 * @param {string | undefined} pathArg
 * @param {{ dataDir: string, now?: Date }} opts
 */
export function resolveBackupTarget(pathArg, { dataDir, now = new Date() }) {
  if (!pathArg) return join(dataDir, "backups", timestampedBackupName(now));
  try {
    if (statSync(pathArg).isDirectory()) return join(pathArg, timestampedBackupName(now));
  } catch {
    // Not an existing path — treat it as an explicit target file.
  }
  return pathArg;
}

// better-sqlite3 is a native dependency; load it lazily so `drydock --help`
// and friends never pay for (or crash on) the binding when it is not needed.
async function loadDatabase() {
  const mod = await import("better-sqlite3");
  return mod.default;
}

/**
 * `drydock backup [path]`: write a consistent snapshot of the SQLite database
 * via better-sqlite3's native `.backup()`, which is WAL-aware — safe while the
 * server is running. Unlike the server's scheduled backup job this never
 * prunes anything: a manual command must not delete files the operator did not
 * ask it to touch.
 *
 * @param {string | undefined} pathArg
 * @param {{ dbPath: string, dataDir: string, now?: Date,
 *           log?: (line: string) => void, error?: (line: string) => void }} deps
 * @returns {Promise<number>} exit code
 */
export async function runBackupCommand(
  pathArg,
  { dbPath, dataDir, now = new Date(), log = console.log, error = console.error },
) {
  if (!existsSync(dbPath)) {
    error(`No database found at ${dbPath} — nothing to back up yet.`);
    return 1;
  }
  const target = resolveBackupTarget(pathArg, { dataDir, now });
  if (existsSync(target)) {
    error(`Backup target already exists: ${target}`);
    return 1;
  }
  mkdirSync(dirname(target), { recursive: true });

  const Database = await loadDatabase();
  const db = new Database(dbPath, { readonly: true });
  try {
    await db.backup(target);
  } finally {
    db.close();
  }
  log(`Backed up ${dbPath} → ${target}`);
  return 0;
}

/**
 * `drydock restore <path>`: replace the live database with a backup. Refuses
 * while a live drydock process holds the instance lock (restoring under a
 * running server would corrupt both states), validates the backup with
 * `PRAGMA integrity_check` before touching anything, and removes the target's
 * `-wal`/`-shm` sidecars so SQLite cannot replay old WAL frames over the
 * restored file. The copy lands in a temp file first and is renamed into
 * place, so a crash mid-copy never leaves a torn database.
 *
 * @param {string} sourcePath
 * @param {{ dbPath: string, lockPath: string, pidAlive?: (pid: number) => boolean,
 *           log?: (line: string) => void, error?: (line: string) => void }} deps
 * @returns {Promise<number>} exit code
 */
export async function runRestoreCommand(
  sourcePath,
  { dbPath, lockPath, pidAlive, log = console.log, error = console.error },
) {
  if (!existsSync(sourcePath)) {
    error(`Backup file not found: ${sourcePath}`);
    return 1;
  }

  const Database = await loadDatabase();
  try {
    const src = new Database(sourcePath, { readonly: true, fileMustExist: true });
    try {
      const rows = src.pragma("integrity_check");
      const ok = Array.isArray(rows) && rows.length === 1 && rows[0]?.integrity_check === "ok";
      if (!ok) {
        error(`${sourcePath} is not a valid SQLite database: integrity check failed.`);
        return 1;
      }
    } finally {
      src.close();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    error(`${sourcePath} is not a valid SQLite database: ${message}`);
    return 1;
  }

  const lock = readLockState(lockPath, pidAlive ? { pidAlive } : {});
  if (lock.state === "held") {
    error(
      `A drydock instance is running (pid ${lock.pid}) — stop it before restoring, ` +
        `otherwise the live server would overwrite the restored state.`,
    );
    return 1;
  }

  mkdirSync(dirname(dbPath), { recursive: true });
  const tmp = `${dbPath}.restore-tmp`;
  copyFileSync(sourcePath, tmp);
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  renameSync(tmp, dbPath);
  log(`Restored ${sourcePath} → ${dbPath}`);
  return 0;
}
