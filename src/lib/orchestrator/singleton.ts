import { inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { pruneOldData } from "@/lib/db/prune";
import { jobs } from "@/lib/db/schema";
import { logError } from "@/lib/log/logger";
import { notifyDraining } from "@/lib/notify/lifecycle";
import { recoverOnStartup } from "./driver";
import { startDriverLoop, stopDriverLoop } from "./driver-loop";
import { transitionJob } from "./jobs";
import { acquireInstanceLock, setDrainMode, waitForIdle } from "./runtime";
import { reapOrphanedWorktrees } from "./worktree-reaper";

/**
 * Orchestrator singleton. instrumentation.ts calls this once on server start.
 * It runs crash recovery (SPEC §8) and installs graceful-shutdown handlers.
 * See ADR 006 and ADR 012.
 */
let started = false;

/** Registry of running subprocess abort callbacks, keyed by job id. */
const abortHandles = new Map<number, (graceMs?: number) => void>();

export function registerAbort(jobId: number, abort: (graceMs?: number) => void): void {
  abortHandles.set(jobId, abort);
}
export function clearAbort(jobId: number): void {
  abortHandles.delete(jobId);
}

const DEFAULT_ABORT_GRACE_MS = 5000;
// Idle wait must exceed the SIGKILL grace so that a process dying exactly at
// the SIGKILL deadline still has time to finish its worktree cleanup before
// process.exit fires (issue #109, fix C).
const IDLE_WAIT_MS = DEFAULT_ABORT_GRACE_MS + 3000;

/**
 * Terminate the running agent subprocess for a single job by invoking its
 * registered abort handle (SIGTERM → SIGKILL after `graceMs`). Returns true if
 * a live handle was found and invoked, false otherwise. The handle is removed
 * so a repeat call is a no-op. Used by the manual Abort/Stop UI action so
 * marking a row `aborted` actually stops the agent (issue #89).
 */
export function abortJob(jobId: number, graceMs = DEFAULT_ABORT_GRACE_MS): boolean {
  const abort = abortHandles.get(jobId);
  // The job id reaches here from a server action argument; guard that the
  // looked-up value is a callable we registered before invoking it, so a
  // caller-supplied id can only ever fire one of our own abort handles.
  if (typeof abort !== "function") return false;
  abort(graceMs);
  abortHandles.delete(jobId);
  return true;
}

/**
 * Terminate every running agent subprocess by draining the abort registry, the
 * same mechanism graceful shutdown uses. Returns the job ids that had a live
 * handle. Backs the navbar emergency stop (issue #89).
 */
export function abortAllJobs(graceMs = DEFAULT_ABORT_GRACE_MS): number[] {
  const ids = [...abortHandles.keys()];
  for (const abort of abortHandles.values()) abort(graceMs);
  abortHandles.clear();
  return ids;
}

/**
 * SPEC §8: drain new work, let in-flight jobs settle briefly, then mark any
 * still-running jobs interrupted and SIGTERM their subprocesses.
 */
export async function gracefulShutdown(): Promise<void> {
  setDrainMode(true);
  stopDriverLoop();
  // Best-effort drain notification (issue #22); never block shutdown on it.
  await notifyDraining().catch((err) => logError("[orchestrator] drain notify failed", err));

  // Signal every running subprocess to terminate first; this unblocks the
  // in-flight runJob() promises so their `finally` worktree cleanup can run.
  abortAllJobs(DEFAULT_ABORT_GRACE_MS);

  // Wait for active jobs to settle (their cleanup + transitions) before exiting.
  // IDLE_WAIT_MS is strictly longer than the SIGKILL grace so that a process
  // that ignores SIGTERM and dies only at SIGKILL still completes its cleanup.
  await waitForIdle(IDLE_WAIT_MS);

  // Anything still in an in-flight state (e.g. its runner did not exit within
  // the grace window) is marked interrupted via the state machine + event log,
  // consistent with crash recovery.
  try {
    const db = getDb();
    const stuck = db
      .select()
      .from(jobs)
      .where(inArray(jobs.status, ["working", "ci_running", "ci_failed", "retrying"]))
      .all();
    for (const job of stuck) {
      try {
        transitionJob(job.id, "interrupted", {}, db);
      } catch (err) {
        logError(`[orchestrator] shutdown transition failed for job ${job.id}`, err);
      }
    }
  } catch (err) {
    logError("[orchestrator] shutdown DB update failed", err);
  }
}

const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Periodically prune verbose job_events past the retention window so the
 * SQLite DB does not grow without bound (issue #24). Runs once at startup and
 * then daily; failures are logged but never crash the orchestrator.
 */
function startPruneSweep(): void {
  const sweep = () => {
    try {
      const { jobEventsDeleted } = pruneOldData(getDb());
      if (jobEventsDeleted > 0)
        console.log(`[orchestrator] pruned ${jobEventsDeleted} job event(s)`);
    } catch (err) {
      logError("[orchestrator] prune sweep failed", err);
    }
  };
  sweep();
  const timer = setInterval(sweep, PRUNE_INTERVAL_MS);
  timer.unref?.();
}

export function startOrchestrator(): void {
  if (started) return;
  started = true;

  // Crash recovery and the scheduler loop run in the real server only. Skipping
  // them under Vitest keeps lazy getDb() bootstraps from mutating per-test DBs or
  // leaving a polling timer running.
  if (!process.env.VITEST) {
    if (acquireInstanceLock()) {
      // Crash recovery runs only in the lock-holding instance, mirroring the
      // worktree-reaper guard (issue #53): a second process sharing the DB
      // would otherwise requeue the live instance's actively-running working
      // jobs and flip its babysat CI states to interrupted before discovering
      // it lost the lock.
      try {
        const { requeued, interrupted } = recoverOnStartup();
        if (requeued > 0) console.log(`[orchestrator] requeued ${requeued} orphaned job(s)`);
        if (interrupted > 0)
          console.log(`[orchestrator] recovered ${interrupted} interrupted job(s)`);
      } catch (err) {
        logError("[orchestrator] recovery failed", err);
      }

      // Only the lock-holding instance reaps worktrees, so a second process
      // never deletes the active instance's in-flight directories (issue #53).
      // The driver loop starts only after the sweep settles: its first tick can
      // create and claim a brand-new job, whose freshly added worktree the
      // sweep's entry-time liveness snapshot would not protect.
      reapOrphanedWorktrees()
        .then((reaped) => {
          if (reaped > 0) console.log(`[orchestrator] reaped ${reaped} orphaned worktree(s)`);
        })
        .catch((err) => logError("[orchestrator] worktree reap failed", err))
        .finally(() => {
          startDriverLoop();
          startPruneSweep();
        });
    } else {
      console.warn("[orchestrator] another instance holds the lock; driver loop not started");
    }
  }

  const onSignal = async (sig: NodeJS.Signals) => {
    console.log(`[orchestrator] ${sig} received, shutting down gracefully`);
    // Await full shutdown — including waitForIdle so in-flight jobs finish their
    // worktree cleanup — before the hard process.exit cuts execution short.
    await gracefulShutdown();
    process.exit(0);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
}
