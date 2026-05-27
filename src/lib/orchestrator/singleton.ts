import { getDb } from "@/lib/db/client";
import { jobs } from "@/lib/db/schema";
import { inArray } from "drizzle-orm";
import { recoverInterruptedJobs } from "./driver";
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

export function startOrchestrator(): void {
  if (started) return;
  started = true;
  try {
    const recovered = recoverInterruptedJobs();
    if (recovered > 0) console.log(`[orchestrator] recovered ${recovered} interrupted job(s)`);
  } catch (err) {
    console.error("[orchestrator] recovery failed", err);
  }

  // Start the scheduler loop in the real server only (skip under Vitest so the
  // test suite doesn't leave a polling timer running).
  if (!process.env.VITEST) {
    if (acquireInstanceLock()) {
      startDriverLoop();
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
