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

/** Outcome / cost-efficiency KPIs over a set of jobs. */
export interface AnalyticsMetrics {
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
}

export interface AnalyticsSummary extends AnalyticsMetrics {
  /** merged jobs per active day; null when there are no active days. */
  mergedPerDay: number | null;
  /** Per-day throughput, newest first. */
  daily: AnalyticsDay[];
}

/** A dimension the outcome KPIs can be grouped by (issue #178). */
export type AnalyticsDimension = "model" | "agent" | "promptVersion";

/** One slice of the KPIs, scoped to a single value of the grouping dimension. */
export interface AnalyticsSlice extends AnalyticsMetrics {
  /** Human-readable dimension value: a model id, agent id, or `v3` / `default`. */
  key: string;
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

/** WHERE clause shared by every analytics query: repo scope + createdAt range. */
function buildWhere(filters: AnalyticsFilters): SQL | undefined {
  const conditions: SQL[] = [];
  if (filters.repoId !== undefined) conditions.push(sql`${jobs.repoId} = ${filters.repoId}`);
  if (filters.since !== undefined) conditions.push(sql`${jobs.createdAt} >= ${filters.since}`);
  if (filters.until !== undefined) conditions.push(sql`${jobs.createdAt} <= ${filters.until}`);
  return conditions.length ? and(...conditions) : undefined;
}

/** Outcome / cost-efficiency KPIs for a set of job rows. */
function computeMetrics(rows: Job[]): AnalyticsMetrics {
  const completed = rows.filter((j) => j.finishedAt !== null);
  const merged = rows.filter((j) => j.status === "merged");

  const mergeTimes = merged
    .filter((j) => j.startedAt !== null && j.finishedAt !== null)
    .map((j) => (j.finishedAt as number) - (j.startedAt as number));

  const totalCostUsd = rows.reduce((sum, j) => sum + j.costUsd, 0);
  const avgCiRetries = completed.length
    ? completed.reduce((sum, j) => sum + j.ciRetryCount, 0) / completed.length
    : 0;

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
  };
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
  const rows: Job[] = db.select().from(jobs).where(buildWhere(filters)).all();
  const metrics = computeMetrics(rows);

  // Per-day throughput, bucketed by the day a job reached a terminal state.
  const byDay = new Map<string, { completed: number; merged: number }>();
  for (const j of rows) {
    if (j.finishedAt === null) continue;
    const day = utcDay(j.finishedAt);
    const bucket = byDay.get(day) ?? { completed: 0, merged: 0 };
    bucket.completed += 1;
    if (j.status === "merged") bucket.merged += 1;
    byDay.set(day, bucket);
  }
  const daily: AnalyticsDay[] = [...byDay.entries()]
    .map(([day, v]) => ({ day, ...v }))
    .sort((a, b) => b.day.localeCompare(a.day));

  return {
    ...metrics,
    mergedPerDay: daily.length ? metrics.mergedJobs / daily.length : null,
    daily,
  };
}

/** The grouping value a job falls under for a dimension. */
function dimensionKey(job: Job, dimension: AnalyticsDimension): string {
  switch (dimension) {
    case "model":
      // Matches the `coalesce(model, 'unknown')` label used by cost-by-model.
      return job.model ?? "unknown";
    case "agent":
      return job.agent;
    case "promptVersion":
      return job.implementPromptVersion === null ? "default" : `v${job.implementPromptVersion}`;
  }
}

/**
 * The same outcome KPIs as {@link analyticsSummary}, grouped by model, agent, or
 * prompt version (issue #178). Read-only reporting over the existing repo and
 * date-range filters; slices are returned busiest-first (most jobs), with the
 * dimension value as a stable tiebreak.
 */
export function analyticsByDimension(
  dimension: AnalyticsDimension,
  filters: AnalyticsFilters = {},
  db: DB = getDb(),
): AnalyticsSlice[] {
  const rows: Job[] = db.select().from(jobs).where(buildWhere(filters)).all();

  const groups = new Map<string, Job[]>();
  for (const job of rows) {
    const key = dimensionKey(job, dimension);
    const bucket = groups.get(key) ?? [];
    bucket.push(job);
    groups.set(key, bucket);
  }

  return [...groups.entries()]
    .map(([key, groupRows]) => ({ key, ...computeMetrics(groupRows) }))
    .sort((a, b) => b.totalJobs - a.totalJobs || a.key.localeCompare(b.key));
}
