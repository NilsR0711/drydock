import { and, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { getSettings } from "@/lib/settings/service";
import { type DB, getDb } from "./client";
import { jobEvents, jobs } from "./schema";

const SECONDS_PER_DAY = 86_400;

export interface PruneOptions {
  /** Retention window in days; defaults to the `retentionDays` setting. */
  days?: number;
  /**
   * Whether to run SQLite VACUUM after deleting. `true` always vacuums, `false`
   * never does. When omitted, VACUUM runs only if rows were actually deleted, so
   * the scheduled sweep skips the full-DB rewrite on no-op runs (issue #416).
   */
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
 * then returns freed pages to the OS — see {@link PruneOptions.vacuum} for when
 * it runs.
 */
export function pruneOldData(db: DB = getDb(), opts: PruneOptions = {}): PruneResult {
  const days = opts.days ?? getSettings(db).retentionDays;
  const nowSec = Math.floor((opts.now?.getTime() ?? Date.now()) / 1000);
  const cutoff = nowSec - days * SECONDS_PER_DAY;

  // Delete via an IN (SELECT …) subquery rather than materializing the expired
  // job IDs into bound parameters: job summary rows are kept forever, so the
  // expired set grows monotonically and binding one variable per ID would hit
  // SQLite's SQLITE_MAX_VARIABLE_NUMBER (32766) after enough lifetime jobs,
  // permanently breaking the sweep (and the VACUUM behind it).
  const expiredJobs = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(isNotNull(jobs.finishedAt), lt(jobs.finishedAt, cutoff)));

  const res = db.delete(jobEvents).where(inArray(jobEvents.jobId, expiredJobs)).run();
  const jobEventsDeleted = res.changes;

  // VACUUM rewrites the whole database and runs synchronously on better-sqlite3's
  // process-wide connection (web server, SSE streams, driver loop), so it stalls
  // the event loop for the DB's full size. When `vacuum` is left unset — the
  // scheduled sweep's path — only pay that cost if we actually freed pages;
  // rewriting after a no-op prune buys nothing. An explicit flag overrides: the
  // CLI passes `true` to always reclaim, `--no-vacuum` passes `false` to skip
  // (issue #416). VACUUM cannot run inside a transaction; better-sqlite3 runs it
  // directly.
  const vacuum = opts.vacuum ?? jobEventsDeleted > 0;
  if (vacuum) db.run(sql`VACUUM`);

  return { jobEventsDeleted, vacuumed: vacuum, cutoff };
}

/** Parse `drydock prune` CLI flags: `--days <n>` / `--days=<n>` and `--no-vacuum`. */
export function parsePruneArgs(argv: readonly string[]): { days?: number; vacuum: boolean } {
  const result: { days?: number; vacuum: boolean } = { vacuum: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--no-vacuum") {
      result.vacuum = false;
    } else if (arg === "--days") {
      result.days = parseDays(argv[++i]);
    } else if (arg?.startsWith("--days=")) {
      result.days = parseDays(arg.slice("--days=".length));
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return result;
}

function parseDays(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`--days expects a positive integer, got: ${raw}`);
  }
  return n;
}
