import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { type DB, getDb } from "@/lib/db/client";
import { issues, type Job, jobEvents, jobs } from "@/lib/db/schema";
import { assertTransition, type JobStatus } from "./state-machine";

export function createJob(
  input: { repoId: number; issueNumber: number; model?: string; maxTurns?: number },
  db: DB = getDb(),
): Job {
  return db
    .insert(jobs)
    .values({
      repoId: input.repoId,
      issueNumber: input.issueNumber,
      status: "queued",
      model: input.model,
      maxTurns: input.maxTurns ?? 40,
    })
    .returning()
    .get();
}

export function getJob(id: number, db: DB = getDb()): Job | undefined {
  return db.select().from(jobs).where(eq(jobs.id, id)).get();
}

export function recordEvent(jobId: number, type: string, payload: unknown, db: DB = getDb()): void {
  db.insert(jobEvents)
    .values({ jobId, type, payload: JSON.stringify(payload ?? {}) })
    .run();
}

/** Transition a job, validating against the state machine and logging an event. */
export function transitionJob(
  jobId: number,
  to: JobStatus,
  patch: Partial<Job> = {},
  db: DB = getDb(),
): Job {
  const job = getJob(jobId, db);
  if (!job) throw new Error(`job ${jobId} not found`);
  assertTransition(job.status as JobStatus, to);
  const now = Math.floor(Date.now() / 1000);
  const extra: Partial<Job> = {};
  if (to === "working" && !job.startedAt) extra.startedAt = now;
  if (["merged", "needs_human", "aborted"].includes(to)) extra.finishedAt = now;
  const updated = db
    .update(jobs)
    .set({ ...extra, ...patch, status: to })
    .where(eq(jobs.id, jobId))
    .returning()
    .get();
  recordEvent(jobId, "status", { from: job.status, to }, db);
  return updated;
}

export function listJobs(repoId: number, db: DB = getDb()): Job[] {
  return db.select().from(jobs).where(eq(jobs.repoId, repoId)).orderBy(desc(jobs.createdAt)).all();
}

export function listJobsByStatus(statuses: JobStatus[], db: DB = getDb()): Job[] {
  return db.select().from(jobs).where(inArray(jobs.status, statuses)).all();
}

/**
 * Next queued job for a repo. Ordered by the manual issue priority
 * (issues.priority, lower = sooner); jobs without a cached issue row sort
 * last, then by creation order as a stable tiebreak.
 */
export function nextQueuedJob(repoId: number, db: DB = getDb()): Job | undefined {
  return db
    .select({ job: jobs })
    .from(jobs)
    .leftJoin(issues, and(eq(issues.repoId, jobs.repoId), eq(issues.number, jobs.issueNumber)))
    .where(and(eq(jobs.repoId, repoId), eq(jobs.status, "queued")))
    .orderBy(sql`COALESCE(${issues.priority}, 1e9)`, jobs.createdAt)
    .get()?.job;
}
