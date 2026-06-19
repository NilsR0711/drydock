import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { type DB, getDb } from "@/lib/db/client";
import { issues, type Job, jobEvents, jobs } from "@/lib/db/schema";
import { getSettings } from "@/lib/settings/service";
import { emitDashboardChange } from "@/lib/stream/dashboard-bus";
import { assertTransition, type JobStatus, OPEN_STATES } from "./state-machine";

export function createJob(
  input: {
    repoId: number;
    issueNumber: number;
    model?: string;
    agent?: string;
    maxTurns?: number;
    /** "issue" (default) or "release" — the job's flow discriminator (issue #256). */
    kind?: "issue" | "release";
    /** Optional dedupe key; uniqueness is enforced across live jobs (issue #23). */
    dedupeKey?: string;
  },
  db: DB = getDb(),
): Job {
  const job = db
    .insert(jobs)
    .values({
      repoId: input.repoId,
      issueNumber: input.issueNumber,
      kind: input.kind ?? "issue",
      status: "queued",
      model: input.model,
      agent: input.agent ?? "claude",
      // The global maxTurns setting is the source of truth for a new job's turn
      // budget (issue #254); an explicit per-call override still wins. 0 here
      // means unlimited and is honored downstream by the runner.
      maxTurns: input.maxTurns ?? getSettings(db).maxTurns,
      dedupeKey: input.dedupeKey ?? null,
    })
    .returning()
    .get();
  emitDashboardChange();
  return job;
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
  // better-sqlite3 transactions are synchronous and serialized on the single
  // process connection, so wrapping the read-validate-write makes the
  // transition atomic: no interleaved write can invalidate the check, and the
  // status update and its event-log entry commit (or roll back) together.
  const updated = db.transaction((tx) => {
    const txDb = tx as unknown as DB;
    const job = getJob(jobId, txDb);
    if (!job) throw new Error(`job ${jobId} not found`);
    assertTransition(job.status as JobStatus, to);
    const now = Math.floor(Date.now() / 1000);
    const extra: Partial<Job> = {};
    if (to === "working" && !job.startedAt) extra.startedAt = now;
    if (["merged", "released", "needs_human", "aborted"].includes(to)) extra.finishedAt = now;
    const row = tx
      .update(jobs)
      .set({ ...extra, ...patch, status: to })
      .where(eq(jobs.id, jobId))
      .returning()
      .get();
    recordEvent(jobId, "status", { from: job.status, to }, txDb);
    return row;
  });
  emitDashboardChange();
  return updated;
}

export function listJobs(repoId: number, db: DB = getDb()): Job[] {
  return db.select().from(jobs).where(eq(jobs.repoId, repoId)).orderBy(desc(jobs.createdAt)).all();
}

export function listJobsByStatus(statuses: JobStatus[], db: DB = getDb()): Job[] {
  return db.select().from(jobs).where(inArray(jobs.status, statuses)).all();
}

/**
 * Map each of a repo's issues to the status of its open (non-terminal) job, so
 * the Issues board can show what is actually scheduled/running regardless of
 * how it was queued — manual queue label or the auto `ready` path (issue #286).
 * Issues without an open job are absent. The dedupe invariant (issue #23) means
 * at most one open job per issue; if more than one somehow exists, the
 * most-recently-created one wins.
 */
export function openJobsByIssue(repoId: number, db: DB = getDb()): Record<number, JobStatus> {
  const open = listJobsByStatus([...OPEN_STATES], db)
    .filter((j) => j.repoId === repoId)
    .sort((a, b) => a.createdAt - b.createdAt);
  const byIssue: Record<number, JobStatus> = {};
  for (const job of open) {
    // Later (newer) jobs overwrite earlier ones, so the freshest status wins.
    byIssue[job.issueNumber] = job.status as JobStatus;
  }
  return byIssue;
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
