import { type DB, getDb } from "@/lib/db/client";
import { type Job, jobEvents, jobs } from "@/lib/db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import { type JobStatus, assertTransition } from "./state-machine";

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

/** Oldest queued job for a repo (driver loop picks this). */
export function nextQueuedJob(repoId: number, db: DB = getDb()): Job | undefined {
  return db
    .select()
    .from(jobs)
    .where(and(eq(jobs.repoId, repoId), eq(jobs.status, "queued")))
    .orderBy(jobs.createdAt)
    .get();
}
