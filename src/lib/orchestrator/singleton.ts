import { getDb } from "@/lib/db/client";
import { jobs } from "@/lib/db/schema";
import { eq, inArray } from "drizzle-orm";
import { recoverInterruptedJobs } from "./driver";

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

/** SPEC §8: mark in-flight jobs interrupted and SIGTERM their subprocesses. */
export function gracefulShutdown(): void {
  try {
    const db = getDb();
    db.update(jobs)
      .set({ status: "interrupted" })
      .where(inArray(jobs.status, ["working", "ci_running", "retrying"]))
      .run();
  } catch (err) {
    console.error("[orchestrator] shutdown DB update failed", err);
  }
  for (const abort of abortHandles.values()) abort(5000);
  abortHandles.clear();
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

  const onSignal = (sig: NodeJS.Signals) => {
    console.log(`[orchestrator] ${sig} received, shutting down gracefully`);
    gracefulShutdown();
    process.exit(0);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
}

// Internal helper retained for symmetry with the recovery path.
export function _markInterrupted(jobId: number): void {
  getDb().update(jobs).set({ status: "interrupted" }).where(eq(jobs.id, jobId)).run();
}
