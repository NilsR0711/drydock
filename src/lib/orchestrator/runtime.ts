import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { worktreeHome } from "@/lib/git/worktree";

let draining = false;
const activeJobs = new Set<number>();

export function setDrainMode(on: boolean): void {
  draining = on;
}
export function isDraining(): boolean {
  return draining;
}

export function registerActiveJob(jobId: number): void {
  activeJobs.add(jobId);
}
export function unregisterActiveJob(jobId: number): void {
  activeJobs.delete(jobId);
}
export function activeJobCount(): number {
  return activeJobs.size;
}

/** Resolve once no jobs are active, or after timeoutMs (whichever first). */
export function waitForIdle(timeoutMs = 30_000, pollMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      if (activeJobs.size === 0 || Date.now() >= deadline) return resolve();
      setTimeout(tick, pollMs);
    };
    tick();
  });
}

function lockPath(): string {
  return join(worktreeHome(), "instance.lock");
}

/**
 * How often the lock holder rewrites its heartbeat timestamp. A live, healthy
 * instance refreshes the lock this often so peers can tell it apart from a dead
 * holder whose pid was later reused.
 */
export const LOCK_HEARTBEAT_MS = 30_000;

/**
 * A lock whose heartbeat is older than this is stale and may be reclaimed even
 * while its recorded pid is still alive. This is the defence against pid reuse
 * (issue #211): after a host crash an unrelated process can inherit the dead
 * holder's pid, so `process.kill(pid, 0)` reports it alive forever — only a
 * fresh heartbeat proves the pid is the real Drydock holder. Three missed
 * heartbeats give ample margin against scheduling jitter.
 */
export const LOCK_TTL_MS = 3 * LOCK_HEARTBEAT_MS;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface LockRecord {
  /** Recorded holder pid, or null when missing/malformed. */
  pid: number | null;
  /** Last heartbeat timestamp (ms), or null when missing/malformed. */
  ts: number | null;
}

/**
 * Parse a lock file's contents. Throws (via JSON.parse) only on corrupt JSON;
 * a well-formed object with missing/invalid fields yields nulls so callers can
 * treat them uniformly as "no provable holder".
 */
function parseLock(text: string): LockRecord {
  const parsed = JSON.parse(text) as { pid?: unknown; ts?: unknown };
  // Only positive integers are valid pids per the lock-file contract. pid 0
  // would make pidAlive() signal our own process group and misreport a corrupt
  // lock as held; negative pids address process groups as well.
  const rawPid = parsed.pid;
  const pid = typeof rawPid === "number" && Number.isInteger(rawPid) && rawPid > 0 ? rawPid : null;
  const rawTs = parsed.ts;
  const ts = typeof rawTs === "number" && Number.isFinite(rawTs) ? rawTs : null;
  return { pid, ts };
}

/** Read and parse the lock file; returns null pids/ts when missing or corrupt. */
function readLock(path: string): LockRecord {
  try {
    return parseLock(readFileSync(path, "utf8"));
  } catch {
    return { pid: null, ts: null };
  }
}

/** Atomically create the lock file, writing our pid and a fresh heartbeat. */
function writeLock(path: string): void {
  // O_EXCL ("wx"): fails if the file already exists, so the create+claim is a
  // single atomic step with no existsSync→writeFileSync TOCTOU window.
  const fd = openSync(path, "wx");
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
  } finally {
    closeSync(fd);
  }
}

/**
 * Decide whether an existing lock may be taken over. Stale when: the file is
 * corrupt or its pid is malformed; the pid is our own (a crashed instance
 * restarted with the same pid — e.g. pid 1 in a container — or a redundant
 * init in this process); the holder pid is dead; or a live holder's heartbeat
 * has expired past the TTL (pid reuse).
 */
function lockIsStale(record: LockRecord, now: number): boolean {
  const { pid, ts } = record;
  if (pid === null) return true;
  if (pid === process.pid) return true;
  if (!pidAlive(pid)) return true;
  return ts === null || now - ts > LOCK_TTL_MS;
}

export interface InstanceLockInfo {
  /** True when a live holder with a fresh heartbeat owns the lock. */
  held: boolean;
  /** Pid recorded in the lock file, if readable. */
  pid: number | null;
  /** True when this process is the holder. */
  self: boolean;
}

/**
 * Read-only view of the instance lock for diagnostics (health endpoint,
 * issue #183). Never creates, rewrites, or steals the lock — a stale, corrupt,
 * or heartbeat-expired lock file is simply reported as not held. The TTL check
 * mirrors acquisition so health does not report a reused pid as a live holder
 * (issue #211).
 */
export function readInstanceLock(): InstanceLockInfo {
  const { pid, ts } = readLock(lockPath());
  const fresh = ts !== null && Date.now() - ts <= LOCK_TTL_MS;
  const held = pid !== null && fresh && pidAlive(pid);
  return { held, pid, self: held && pid === process.pid };
}

/**
 * Best-effort single-instance guard. Returns true if this process now holds the
 * lock. A lock held by a dead pid, a reused pid (expired heartbeat), or our own
 * pid is considered stale and taken over. The caller should start the heartbeat
 * (startInstanceLockHeartbeat) so the lock stays fresh for as long as it runs.
 */
export function acquireInstanceLock(): boolean {
  const path = lockPath();
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeLock(path);
    return true;
  } catch {
    // Lock file already exists — inspect it for staleness.
  }

  if (!lockIsStale(readLock(path), Date.now())) return false;

  // Stale lock: remove and re-claim atomically. If another instance wins the
  // race to recreate it between unlink and create, our create fails and we back off.
  try {
    unlinkSync(path);
    writeLock(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Rewrite the lock's heartbeat timestamp, but only while this process is still
 * the recorded holder. Returns false (without touching the file) once another
 * instance has taken over, so a late heartbeat never clobbers the new owner.
 */
export function refreshInstanceLock(): boolean {
  const path = lockPath();
  if (readLock(path).pid !== process.pid) return false;
  try {
    writeFileSync(path, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Periodically refresh the instance lock so peers can tell this live holder
 * apart from a stale one. Stops itself the moment the lock is lost. Idempotent:
 * a prior heartbeat is cleared first. The timer is unref'd so it never keeps the
 * process alive on its own.
 */
export function startInstanceLockHeartbeat(intervalMs = LOCK_HEARTBEAT_MS): void {
  stopInstanceLockHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (!refreshInstanceLock()) stopInstanceLockHeartbeat();
  }, intervalMs);
  heartbeatTimer.unref?.();
}

/** Stop the heartbeat timer if one is running. */
export function stopInstanceLockHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/**
 * Release the lock on graceful shutdown: stop the heartbeat and remove the file
 * if we still own it, so a restart re-acquires instantly instead of waiting out
 * the TTL. A lock owned by another pid (we already lost it) is left untouched.
 */
export function releaseInstanceLock(): void {
  stopInstanceLockHeartbeat();
  const path = lockPath();
  if (readLock(path).pid !== process.pid) return;
  try {
    unlinkSync(path);
  } catch {
    // already gone — nothing to release
  }
}
