import { type DB, getDb } from "@/lib/db/client";
import { jobs } from "@/lib/db/schema";
import { eq, inArray } from "drizzle-orm";
import { recordEvent } from "./jobs";
import type { JobStatus } from "./state-machine";

/**
 * In-flight states that must be recovered to `interrupted` on restart. Includes
 * `ci_failed` because the babysitter transitions through it on its way to
 * `retrying`; a crash there would otherwise strand the job forever.
 */
const IN_FLIGHT_STATES: JobStatus[] = ["working", "ci_running", "ci_failed", "retrying"];

/**
 * Crash recovery (SPEC §8): on server start, any job left in an in-flight state
 * is marked `interrupted` so the operator can restart it. See ADR 008.
 */
export function recoverInterruptedJobs(db: DB = getDb()): number {
  const inFlight = db.select().from(jobs).where(inArray(jobs.status, IN_FLIGHT_STATES)).all();

  for (const job of inFlight) {
    db.update(jobs).set({ status: "interrupted" }).where(eq(jobs.id, job.id)).run();
    recordEvent(job.id, "status", { from: job.status, to: "interrupted", reason: "recovery" }, db);
  }
  return inFlight.length;
}
