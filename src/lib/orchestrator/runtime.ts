import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
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

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Atomically create the lock file, writing our pid into it. */
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
 * Best-effort single-instance guard. Returns true if this process now holds the
 * lock. A lock held by a dead pid is considered stale and taken over.
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

  let stale = false;
  try {
    const { pid } = JSON.parse(readFileSync(path, "utf8")) as { pid: number };
    if (!pidAlive(pid)) stale = true;
  } catch {
    // corrupt lock file — treat as stale
    stale = true;
  }
  if (!stale) return false;

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
