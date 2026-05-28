import { inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { pruneOldData } from "@/lib/db/prune";
import { jobs } from "@/lib/db/schema";
import { recoverOnStartup } from "./driver";
import { startDriverLoop, stopDriverLoop } from "./driver-loop";
import { transitionJob } from "./jobs";
import { acquireInstanceLock, setDrainMode, waitForIdle } from "./runtime";

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

/**
 * SPEC §8: drain new work, let in-flight jobs settle briefly, then mark any
 * still-running jobs interrupted and SIGTERM their subprocesses.
 */
export async function gracefulShutdown(): Promise<void> {
  setDrainMode(true);
  stopDriverLoop();

  // Signal every running subprocess to terminate first; this unblocks the
  // in-flight runJob() promises so their `finally` worktree cleanup can run.
  for (const abort of abortHandles.values()) abort(5000);
  abortHandles.clear();

  // Wait for active jobs to settle (their cleanup + transitions) before exiting.
  await waitForIdle(5000);

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
        console.error(`[orchestrator] shutdown transition failed for job ${job.id}`, err);
      }
    }
  } catch (err) {
    console.error("[orchestrator] shutdown DB update failed", err);
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
      console.error("[orchestrator] prune sweep failed", err);
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
    try {
      const { requeued, interrupted } = recoverOnStartup();
      if (requeued > 0) console.log(`[orchestrator] requeued ${requeued} orphaned job(s)`);
      if (interrupted > 0)
        console.log(`[orchestrator] recovered ${interrupted} interrupted job(s)`);
    } catch (err) {
      console.error("[orchestrator] recovery failed", err);
    }

    if (acquireInstanceLock()) {
      startDriverLoop();
      startPruneSweep();
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
