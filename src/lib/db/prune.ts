import { and, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { getSettings } from "@/lib/settings/service";
import { type DB, getDb } from "./client";
import { jobEvents, jobs } from "./schema";

const SECONDS_PER_DAY = 86_400;

export interface PruneOptions {
  /** Retention window in days; defaults to the `retentionDays` setting. */
  days?: number;
  /** Run SQLite VACUUM after deleting to reclaim space (default true). */
  vacuum?: boolean;
  /** Injectable clock for deterministic tests. */
  now?: Date;
}

export interface PruneResult {
  /** Number of verbose job_events rows deleted. */
  jobEventsDeleted: number;
  /** Whether VACUUM ran. */
  vacuumed: boolean;
  /** The unix-second cutoff: events of jobs finished before this were pruned. */
  cutoff: number;
}

/**
 * Reclaim space from long-running autonomous operation (issue #24). Deletes the
 * verbose `job_events` of jobs that finished before the retention window, while
 * keeping the jobs' own summary rows (status, cost, tokens) so cost reporting
 * stays intact. Events of unfinished jobs are never touched. A SQLite VACUUM
 * then returns freed pages to the OS unless explicitly disabled.
 */
export function pruneOldData(db: DB = getDb(), opts: PruneOptions = {}): PruneResult {
  const days = opts.days ?? getSettings(db).retentionDays;
  const vacuum = opts.vacuum ?? true;
  const nowSec = Math.floor((opts.now?.getTime() ?? Date.now()) / 1000);
  const cutoff = nowSec - days * SECONDS_PER_DAY;

  const expiredJobs = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(isNotNull(jobs.finishedAt), lt(jobs.finishedAt, cutoff)))
    .all()
    .map((r) => r.id);

  let jobEventsDeleted = 0;
  if (expiredJobs.length > 0) {
    const res = db.delete(jobEvents).where(inArray(jobEvents.jobId, expiredJobs)).run();
    jobEventsDeleted = res.changes;
  }

  // VACUUM cannot run inside a transaction; better-sqlite3 executes it directly.
  if (vacuum) db.run(sql`VACUUM`);

  return { jobEventsDeleted, vacuumed: vacuum, cutoff };
}
