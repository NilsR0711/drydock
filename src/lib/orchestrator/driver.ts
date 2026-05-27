import { type DB, getDb } from "@/lib/db/client";
import { jobs } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { recordEvent } from "./jobs";

/**
 * Crash recovery (SPEC §8): on server start, any job left in an in-flight state
 * is marked `interrupted` so the operator can restart it. See ADR 008.
 */
export function recoverInterruptedJobs(db: DB = getDb()): number {
  const inFlight = db
    .select()
    .from(jobs)
    .where(eq(jobs.status, "working"))
    .all()
    .concat(db.select().from(jobs).where(eq(jobs.status, "ci_running")).all())
    .concat(db.select().from(jobs).where(eq(jobs.status, "retrying")).all());

  for (const job of inFlight) {
    db.update(jobs).set({ status: "interrupted" }).where(eq(jobs.id, job.id)).run();
    recordEvent(job.id, "status", { from: job.status, to: "interrupted", reason: "recovery" }, db);
  }
  return inFlight.length;
}
