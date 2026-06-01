import { and, type SQL, sql } from "drizzle-orm";
import { type DB, getDb } from "./client";
import { type Job, jobs } from "./schema";

export interface AnalyticsFilters {
  /** Scope to a single repo. */
  repoId?: number;
  /** Inclusive lower bound on job createdAt (unix seconds). */
  since?: number;
  /** Inclusive upper bound on job createdAt (unix seconds). */
  until?: number;
}

/** One day's throughput: jobs that reached a terminal state, and of those, merges. */
export interface AnalyticsDay {
  /** UTC calendar day, `YYYY-MM-DD`. */
  day: string;
  completed: number;
  merged: number;
}

export interface AnalyticsSummary {
  totalJobs: number;
  /** Jobs that reached a terminal state (have a finishedAt). */
  completedJobs: number;
  mergedJobs: number;
  /** merged / completed, in [0, 1]; 0 when nothing has completed. */
  mergeRate: number;
  /** Median time from start to merge, in seconds; null when nothing has merged. */
  timeToMergeP50Sec: number | null;
  /** 90th-percentile time from start to merge, in seconds; null when nothing has merged. */
  timeToMergeP90Sec: number | null;
  /** Mean CI retries over completed jobs; 0 when nothing has completed. */
  avgCiRetries: number;
  totalCostUsd: number;
  /** totalCost / merged; null when nothing has merged. */
  costPerMergedUsd: number | null;
  /** merged jobs per active day; null when there are no active days. */
  mergedPerDay: number | null;
  /** Per-day throughput, newest first. */
  daily: AnalyticsDay[];
}

/** UTC calendar day for a unix-seconds timestamp. */
function utcDay(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * Nearest-rank percentile of an unsorted numeric sample. `p` is a fraction in
 * [0, 1]. Returns null for an empty sample.
 */
function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length);
  const idx = Math.min(Math.max(rank, 1), sorted.length) - 1;
  return sorted[idx] ?? null;
}

/**
 * Outcome / throughput / cost-efficiency analytics for the dock (issue #111).
 * Derived entirely from the existing `jobs` columns (status, startedAt,
 * finishedAt, ciRetryCount, costUsd) — no schema change. Sliceable by repo and
 * by a createdAt date range. All aggregation happens in JS so percentiles and
 * timezone-stable day bucketing stay deterministic across SQLite builds.
 */
export function analyticsSummary(
  filters: AnalyticsFilters = {},
  db: DB = getDb(),
): AnalyticsSummary {
  const conditions: SQL[] = [];
  if (filters.repoId !== undefined) conditions.push(sql`${jobs.repoId} = ${filters.repoId}`);
  if (filters.since !== undefined) conditions.push(sql`${jobs.createdAt} >= ${filters.since}`);
  if (filters.until !== undefined) conditions.push(sql`${jobs.createdAt} <= ${filters.until}`);
  const where = conditions.length ? and(...conditions) : undefined;

  const rows: Job[] = db.select().from(jobs).where(where).all();

  const completed = rows.filter((j) => j.finishedAt !== null);
  const merged = rows.filter((j) => j.status === "merged");

  const mergeTimes = merged
    .filter((j) => j.startedAt !== null && j.finishedAt !== null)
    .map((j) => (j.finishedAt as number) - (j.startedAt as number));

  const totalCostUsd = rows.reduce((sum, j) => sum + j.costUsd, 0);
  const avgCiRetries = completed.length
    ? completed.reduce((sum, j) => sum + j.ciRetryCount, 0) / completed.length
    : 0;

  // Per-day throughput, bucketed by the day a job reached a terminal state.
  const byDay = new Map<string, { completed: number; merged: number }>();
  for (const j of completed) {
    const day = utcDay(j.finishedAt as number);
    const bucket = byDay.get(day) ?? { completed: 0, merged: 0 };
    bucket.completed += 1;
    if (j.status === "merged") bucket.merged += 1;
    byDay.set(day, bucket);
  }
  const daily: AnalyticsDay[] = [...byDay.entries()]
    .map(([day, v]) => ({ day, ...v }))
    .sort((a, b) => b.day.localeCompare(a.day));

  return {
    totalJobs: rows.length,
    completedJobs: completed.length,
    mergedJobs: merged.length,
    mergeRate: completed.length ? merged.length / completed.length : 0,
    timeToMergeP50Sec: percentile(mergeTimes, 0.5),
    timeToMergeP90Sec: percentile(mergeTimes, 0.9),
    avgCiRetries,
    totalCostUsd,
    costPerMergedUsd: merged.length ? totalCostUsd / merged.length : null,
    mergedPerDay: daily.length ? merged.length / daily.length : null,
    daily,
  };
}
