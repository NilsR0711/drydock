import { and, desc, type SQL, sql } from "drizzle-orm";
import { type DB, getDb } from "./client";
import { type Job, jobs, oneShotCosts } from "./schema";

export interface DailyCost {
  day: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface ModelCost {
  model: string;
  costUsd: number;
}

const repoFilter = (repoId?: number): SQL | undefined =>
  repoId === undefined ? undefined : sql`${jobs.repoId} = ${repoId}`;

/**
 * Per-day token + cost totals (local time), newest first. Optionally scoped to a
 * repo. Includes one-shot costs (decompose/release) the same way todayCost does,
 * so daily trends stay consistent with the budget gauge.
 */
export function dailyCosts(db: DB = getDb(), repoId?: number): DailyCost[] {
  const jobRows = db
    .select({
      day: sql<string>`strftime('%Y-%m-%d', ${jobs.startedAt}, 'unixepoch', 'localtime')`,
      inputTokens: sql<number>`coalesce(sum(${jobs.totalInputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${jobs.totalOutputTokens}), 0)`,
      costUsd: sql<number>`coalesce(sum(${jobs.costUsd}), 0)`,
    })
    .from(jobs)
    .where(and(sql`${jobs.startedAt} is not null`, repoFilter(repoId)))
    .groupBy(sql`1`)
    .all();

  const oneShotRows = db
    .select({
      day: sql<string>`strftime('%Y-%m-%d', ${oneShotCosts.createdAt}, 'unixepoch', 'localtime')`,
      inputTokens: sql<number>`coalesce(sum(${oneShotCosts.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${oneShotCosts.outputTokens}), 0)`,
      costUsd: sql<number>`coalesce(sum(${oneShotCosts.costUsd}), 0)`,
    })
    .from(oneShotCosts)
    .where(repoId === undefined ? undefined : sql`${oneShotCosts.repoId} = ${repoId}`)
    .groupBy(sql`1`)
    .all();

  const byDay = new Map<string, DailyCost>();
  for (const r of [...jobRows, ...oneShotRows]) {
    const e = byDay.get(r.day) ?? { day: r.day, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    e.inputTokens += r.inputTokens;
    e.outputTokens += r.outputTokens;
    e.costUsd += r.costUsd;
    byDay.set(r.day, e);
  }
  return [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day));
}

export function costByModel(db: DB = getDb(), repoId?: number, since?: number): ModelCost[] {
  // Filter on createdAt to match analyticsSummary's date window, so "spend by
  // model" agrees with the rest of the analytics panel for the same range.
  const sinceFilter = since === undefined ? undefined : sql`${jobs.createdAt} >= ${since}`;
  return db
    .select({
      model: sql<string>`coalesce(${jobs.model}, 'unknown')`,
      costUsd: sql<number>`coalesce(sum(${jobs.costUsd}), 0)`,
    })
    .from(jobs)
    .where(and(repoFilter(repoId), sinceFilter))
    .groupBy(jobs.model)
    .all();
}

export function topJobs(limit = 10, db: DB = getDb(), repoId?: number): Job[] {
  return db
    .select()
    .from(jobs)
    .where(repoFilter(repoId))
    .orderBy(desc(jobs.costUsd))
    .limit(limit)
    .all();
}

/**
 * Unix-second timestamp of the most recent local midnight — the inclusive lower
 * bound for "today". Computed in JS (via the runtime's local timezone, matching
 * SQLite's `localtime`) so the SQL predicate stays a plain `started_at >= ?`
 * range an index can serve, instead of a per-row `strftime(...)` that can never
 * use an index and forces a full scan of the forever-growing jobs table (#415).
 */
export function localDayStart(now: Date = new Date()): number {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor(midnight.getTime() / 1000);
}

/** Total cost for the current local day — used to enforce the daily limit. */
export function todayCost(db: DB = getDb(), repoId?: number): number {
  const since = localDayStart();
  const repoWhere = repoId !== undefined ? sql` AND repo_id = ${repoId}` : sql``;

  // Union job costs + one-shot costs for today. Raw SQL is cleaner than two
  // separate Drizzle queries because Drizzle doesn't expose UNION ALL natively.
  // The `>= since` bound is index-friendly (jobs_started_at_idx /
  // one_shot_costs_created_at_idx) and implicitly drops NULL started_at rows.
  const row = db.get<{ total: number }>(sql`
      SELECT coalesce(sum(c), 0) AS total FROM (
        SELECT coalesce(sum(cost_usd), 0) AS c
        FROM jobs
        WHERE started_at >= ${since}
          ${repoWhere}
        UNION ALL
        SELECT coalesce(sum(cost_usd), 0) AS c
        FROM one_shot_costs
        WHERE created_at >= ${since}
          ${repoWhere}
      )
    `);
  return row?.total ?? 0;
}

/**
 * Total cost for the current local month (month-to-date) — the longer-horizon
 * sibling of {@link todayCost}, used to enforce the monthly limit (issue #413).
 * Mirrors todayCost exactly (jobs + one-shot costs, optional repo scope) but
 * compares the `%Y-%m` window instead of `%Y-%m-%d`, so the monthly gate stays
 * consistent with the daily one.
 */
export function monthCost(db: DB = getDb(), repoId?: number): number {
  const repoWhere = repoId !== undefined ? sql` AND repo_id = ${repoId}` : sql``;
  const row = db.get<{ total: number }>(sql`
      SELECT coalesce(sum(c), 0) AS total FROM (
        SELECT coalesce(sum(cost_usd), 0) AS c
        FROM jobs
        WHERE strftime('%Y-%m', started_at, 'unixepoch', 'localtime') = strftime('%Y-%m', 'now', 'localtime')
          AND started_at IS NOT NULL
          ${repoWhere}
        UNION ALL
        SELECT coalesce(sum(cost_usd), 0) AS c
        FROM one_shot_costs
        WHERE strftime('%Y-%m', created_at, 'unixepoch', 'localtime') = strftime('%Y-%m', 'now', 'localtime')
          ${repoWhere}
      )
    `);
  return row?.total ?? 0;
}

export interface MonthlyProjection {
  /** Spend so far this calendar month (USD). */
  monthToDate: number;
  /** Trailing 7-day average daily spend (USD/day). */
  avgDailySpend: number;
  /** Projected total spend for the whole month (USD): month-to-date + run rate. */
  projected: number;
}

/**
 * Project end-of-month spend from month-to-date plus the trailing-7-day run rate
 * (issue #413). Kept pure — the caller supplies the clock-derived day-of-month
 * and days-in-month — so the projection math is unit-testable without mocking
 * time. The trailing-7 average already covers today's partial spend, so we only
 * extrapolate over the days strictly *after* today: `monthToDate + avg ×
 * (daysInMonth − dayOfMonth)`. On the last day of the month there are no
 * remaining days, so the projection collapses to month-to-date.
 */
export function projectMonthlySpend(input: {
  monthToDate: number;
  /** Sum of spend over the trailing 7 calendar days (USD), including today. */
  trailing7Total: number;
  /** 1-based day of the current month. */
  dayOfMonth: number;
  daysInMonth: number;
}): MonthlyProjection {
  const avgDailySpend = input.trailing7Total / 7;
  const remainingDays = Math.max(input.daysInMonth - input.dayOfMonth, 0);
  const projected = input.monthToDate + avgDailySpend * remainingDays;
  return { monthToDate: input.monthToDate, avgDailySpend, projected };
}

/**
 * Today's spend (jobs + one-shot costs, local day) grouped by repo, in two
 * grouped queries instead of the N+1 per-repo `todayCost` calls the dashboard
 * snapshot used to make (issue #415). Repos with no spend today are simply
 * absent from the map; callers default to 0.
 */
export function todaySpendByRepo(db: DB = getDb()): Map<number, number> {
  const since = localDayStart();
  const jobRows = db
    .select({
      repoId: jobs.repoId,
      cost: sql<number>`coalesce(sum(${jobs.costUsd}), 0)`,
    })
    .from(jobs)
    .where(sql`${jobs.startedAt} >= ${since}`)
    .groupBy(jobs.repoId)
    .all();
  const oneShotRows = db
    .select({
      repoId: oneShotCosts.repoId,
      cost: sql<number>`coalesce(sum(${oneShotCosts.costUsd}), 0)`,
    })
    .from(oneShotCosts)
    .where(sql`${oneShotCosts.createdAt} >= ${since}`)
    .groupBy(oneShotCosts.repoId)
    .all();

  const byRepo = new Map<number, number>();
  for (const r of [...jobRows, ...oneShotRows]) {
    byRepo.set(r.repoId, (byRepo.get(r.repoId) ?? 0) + r.cost);
  }
  return byRepo;
}
