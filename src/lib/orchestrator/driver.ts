import { eq, inArray } from "drizzle-orm";
import { type DB, getDb } from "@/lib/db/client";
import { jobs } from "@/lib/db/schema";
import { recordEvent } from "./jobs";
import { requeueExpiredLeases } from "./queue";
import type { JobStatus } from "./state-machine";

/**
 * Babysitting states recovered to `interrupted` on restart. `working` is handled
 * separately by the lease queue (requeued to `queued`); the CI states carry live
 * PR/CI state that should not silently restart, so they park as `interrupted` for
 * an operator. `ci_failed` is included because the babysitter passes through it
 * en route to `retrying`; a crash there would otherwise strand the job. See ADR 008.
 */
const IN_FLIGHT_STATES: JobStatus[] = ["ci_running", "ci_failed", "retrying"];

/**
 * Crash recovery for the CI-babysitting states: any job stuck in one is marked
 * `interrupted` so the operator can restart it. See ADR 008.
 */
export function recoverInterruptedJobs(db: DB = getDb()): number {
  const inFlight = db.select().from(jobs).where(inArray(jobs.status, IN_FLIGHT_STATES)).all();

  for (const job of inFlight) {
    db.update(jobs).set({ status: "interrupted" }).where(eq(jobs.id, job.id)).run();
    recordEvent(job.id, "status", { from: job.status, to: "interrupted", reason: "recovery" }, db);
  }
  return inFlight.length;
}

/**
 * Full startup crash recovery (issue #23). Jobs left `working` by a crashed
 * worker are requeued to `queued` with a backoff (their lease holder is gone);
 * jobs stuck in a CI-babysitting state are parked `interrupted`. Returns the
 * counts so the caller can log them.
 */
export function recoverOnStartup(db: DB = getDb()): { requeued: number; interrupted: number } {
  const requeued = requeueExpiredLeases({}, db);
  const interrupted = recoverInterruptedJobs(db);
  return { requeued, interrupted };
}
