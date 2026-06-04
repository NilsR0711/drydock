import { and, desc, type SQL, sql } from "drizzle-orm";
import { type DB, getDb } from "./client";
import { type Job, jobs } from "./schema";

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

/** Per-day token + cost totals (local time), newest first. Optionally scoped to a repo. */
export function dailyCosts(db: DB = getDb(), repoId?: number): DailyCost[] {
  return db
    .select({
      day: sql<string>`strftime('%Y-%m-%d', ${jobs.startedAt}, 'unixepoch', 'localtime')`,
      inputTokens: sql<number>`coalesce(sum(${jobs.totalInputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${jobs.totalOutputTokens}), 0)`,
      costUsd: sql<number>`coalesce(sum(${jobs.costUsd}), 0)`,
    })
    .from(jobs)
    .where(and(sql`${jobs.startedAt} is not null`, repoFilter(repoId)))
    .groupBy(sql`1`)
    .orderBy(sql`1 desc`)
    .all();
}

export function costByModel(db: DB = getDb(), repoId?: number, since?: number): ModelCost[] {
  const sinceFilter = since === undefined ? undefined : sql`${jobs.startedAt} >= ${since}`;
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

/** Total cost for the current local day — used to enforce the daily limit. */
export function todayCost(db: DB = getDb(), repoId?: number): number {
  const repoWhere = repoId !== undefined ? sql` AND repo_id = ${repoId}` : sql``;

  // Union job costs + one-shot costs for today. Raw SQL is cleaner than two
  // separate Drizzle queries because Drizzle doesn't expose UNION ALL natively.
  const row = db.get<{ total: number }>(sql`
      SELECT coalesce(sum(c), 0) AS total FROM (
        SELECT coalesce(sum(cost_usd), 0) AS c
        FROM jobs
        WHERE strftime('%Y-%m-%d', started_at, 'unixepoch', 'localtime') = strftime('%Y-%m-%d', 'now', 'localtime')
          AND started_at IS NOT NULL
          ${repoWhere}
        UNION ALL
        SELECT coalesce(sum(cost_usd), 0) AS c
        FROM one_shot_costs
        WHERE strftime('%Y-%m-%d', created_at, 'unixepoch', 'localtime') = strftime('%Y-%m-%d', 'now', 'localtime')
          ${repoWhere}
      )
    `);
  return row?.total ?? 0;
}
