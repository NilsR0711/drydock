import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { and, eq, inArray, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import { type DB, getDb } from "@/lib/db/client";
import { issues, type Job, jobs } from "@/lib/db/schema";
import { createJob, recordEvent, transitionJob } from "./jobs";
import { TERMINAL_STATES } from "./state-machine";

/** Default lease duration: a claimed job must heartbeat within this window. */
export const DEFAULT_LEASE_MS = 30_000;
/** Recommended heartbeat cadence (well under DEFAULT_LEASE_MS). */
export const HEARTBEAT_MS = 10_000;

const nowSec = (): number => Math.floor(Date.now() / 1000);

let cachedWorkerId: string | undefined;

/** Stable identity for this worker process (host + pid). */
export function workerId(): string {
  if (!cachedWorkerId) cachedWorkerId = `${hostname()}#${process.pid}`;
  return cachedWorkerId;
}

/**
 * Exponential backoff (seconds) for a requeued job, scaled by attempt count and
 * capped. Attempt 1 → base, doubling each further attempt. Zero before the first.
 */
export function backoffSeconds(attempts: number, baseSec = 5, capSec = 300): number {
  if (attempts <= 0) return 0;
  return Math.min(baseSec * 2 ** (attempts - 1), capSec);
}

export interface ClaimOptions {
  /** Restrict the claim to these repo ids (e.g. the repos a tick deems eligible). */
  repoIds?: number[];
  /**
   * Skip jobs of these agents (issue #166): while a provider's limit latch is
   * blocking, its jobs stay queued and other agents' work proceeds.
   */
  excludeAgents?: string[];
  /** Lease duration in ms (default DEFAULT_LEASE_MS). */
  leaseMs?: number;
  /** Worker identity to stamp on the lease (default workerId()). */
  worker?: string;
  /** Override the current time (seconds) — for tests. */
  now?: number;
}

/**
 * Atomically claim the globally highest-priority eligible queued job: status
 * `queued`, available now (availableAt null or due), and within the optional
 * repo allow-list. The claim stamps a fresh lease token, worker id and expiry,
 * increments attempts, clears availableAt, and transitions the job to working.
 * Returns the claimed job, or undefined when nothing is eligible.
 */
export function claimNext(opts: ClaimOptions = {}, db: DB = getDb()): Job | undefined {
  const { repoIds, excludeAgents } = opts;
  if (repoIds && repoIds.length === 0) return undefined;
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  const worker = opts.worker ?? workerId();
  const now = opts.now ?? nowSec();

  // better-sqlite3 transactions are synchronous and serialized on the single
  // process connection, so the select-then-update below is an atomic claim.
  return db.transaction((tx) => {
    const candidate = tx
      .select({ job: jobs })
      .from(jobs)
      .leftJoin(issues, and(eq(issues.repoId, jobs.repoId), eq(issues.number, jobs.issueNumber)))
      .where(
        and(
          eq(jobs.status, "queued"),
          or(isNull(jobs.availableAt), lte(jobs.availableAt, now)),
          repoIds ? inArray(jobs.repoId, repoIds) : undefined,
          excludeAgents && excludeAgents.length > 0
            ? notInArray(jobs.agent, excludeAgents)
            : undefined,
        ),
      )
      .orderBy(sql`COALESCE(${issues.priority}, 1e9)`, jobs.createdAt)
      .get()?.job;
    if (!candidate) return undefined;

    return transitionJob(
      candidate.id,
      "working",
      {
        leaseToken: randomUUID(),
        leaseExpiresAt: now + Math.ceil(leaseMs / 1000),
        workerId: worker,
        attempts: candidate.attempts + 1,
        availableAt: null,
      },
      tx as unknown as DB,
    );
  });
}

/**
 * Extend a job's lease. Succeeds only when the token matches the still-working
 * job (optimistic lock); a stale token is rejected with a false return.
 */
export function heartbeat(
  jobId: number,
  leaseToken: string,
  opts: { leaseMs?: number; now?: number } = {},
  db: DB = getDb(),
): boolean {
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  const now = opts.now ?? nowSec();
  const res = db
    .update(jobs)
    .set({ leaseExpiresAt: now + Math.ceil(leaseMs / 1000) })
    .where(and(eq(jobs.id, jobId), eq(jobs.leaseToken, leaseToken), eq(jobs.status, "working")))
    .run();
  return res.changes > 0;
}

/**
 * Finalize a job's lease by clearing the lease fields. Requires the matching
 * lease token (optimistic lock): a stale token is rejected (false return) and
 * the lease is left intact, so a worker that lost its lease cannot finalize it.
 */
export function releaseLease(jobId: number, leaseToken: string, db: DB = getDb()): boolean {
  const res = db
    .update(jobs)
    .set({ leaseToken: null, leaseExpiresAt: null, workerId: null })
    .where(and(eq(jobs.id, jobId), eq(jobs.leaseToken, leaseToken)))
    .run();
  return res.changes > 0;
}

/**
 * Requeue jobs left `working` by a crashed worker. By default every working job
 * is requeued (its lease holder is gone, so the lease is treated as expired);
 * pass `expiredBefore` to requeue only leases that lapsed before that time.
 * Each requeued job returns to `queued` with its lease cleared and an
 * attempt-scaled backoff via availableAt. Returns the number requeued.
 */
export function requeueExpiredLeases(
  opts: { now?: number; expiredBefore?: number } = {},
  db: DB = getDb(),
): number {
  const now = opts.now ?? nowSec();
  const threshold = opts.expiredBefore;
  const expiryFilter =
    threshold === undefined
      ? undefined
      : or(isNull(jobs.leaseExpiresAt), lte(jobs.leaseExpiresAt, threshold));

  const orphaned = db
    .select()
    .from(jobs)
    .where(and(eq(jobs.status, "working"), expiryFilter))
    .all();

  for (const job of orphaned) {
    db.update(jobs)
      .set({
        status: "queued",
        leaseToken: null,
        leaseExpiresAt: null,
        workerId: null,
        availableAt: now + backoffSeconds(job.attempts),
      })
      .where(eq(jobs.id, job.id))
      .run();
    recordEvent(job.id, "status", { from: "working", to: "queued", reason: "lease_expired" }, db);
  }
  return orphaned.length;
}

interface SqliteError extends Error {
  code?: string;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Error &&
    typeof (err as SqliteError).code === "string" &&
    (err as SqliteError).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

export interface EnqueueInput {
  repoId: number;
  issueNumber: number;
  model?: string;
  agent?: string;
  maxTurns?: number;
  /** Dedupe key; defaults to `${repoId}:${issueNumber}`. */
  dedupeKey?: string;
}

/**
 * Enqueue a job, deduplicated by key. If a live (non-terminal) job already
 * holds the key, no job is created and undefined is returned. A partial unique
 * index backs this so a lost race is caught at the DB and likewise yields
 * undefined rather than a duplicate.
 */
export function enqueueJob(input: EnqueueInput, db: DB = getDb()): Job | undefined {
  const dedupeKey = input.dedupeKey ?? `${input.repoId}:${input.issueNumber}`;
  const existing = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.dedupeKey, dedupeKey), notInArray(jobs.status, [...TERMINAL_STATES])))
    .get();
  if (existing) return undefined;
  try {
    return createJob({ ...input, dedupeKey }, db);
  } catch (err) {
    if (isUniqueViolation(err)) return undefined;
    throw err;
  }
}
