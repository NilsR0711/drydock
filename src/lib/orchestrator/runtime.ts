import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/**
 * Best-effort single-instance guard. Returns true if this process now holds the
 * lock. A lock held by a dead pid is considered stale and taken over.
 */
export function acquireInstanceLock(): boolean {
  const path = lockPath();
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    try {
      const { pid } = JSON.parse(readFileSync(path, "utf8")) as { pid: number };
      if (pidAlive(pid)) return false;
    } catch {
      // corrupt lock file — treat as stale and overwrite
    }
  }
  writeFileSync(path, JSON.stringify({ pid: process.pid, ts: Date.now() }));
  return true;
}
