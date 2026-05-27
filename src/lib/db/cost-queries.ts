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

/** Per-day token + cost totals (UTC), newest first. Optionally scoped to a repo. */
export function dailyCosts(db: DB = getDb(), repoId?: number): DailyCost[] {
  return db
    .select({
      day: sql<string>`strftime('%Y-%m-%d', ${jobs.startedAt}, 'unixepoch')`,
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

export function costByModel(db: DB = getDb(), repoId?: number): ModelCost[] {
  return db
    .select({
      model: sql<string>`coalesce(${jobs.model}, 'unknown')`,
      costUsd: sql<number>`coalesce(sum(${jobs.costUsd}), 0)`,
    })
    .from(jobs)
    .where(repoFilter(repoId))
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

/** Total cost for the current UTC day — used to enforce the daily limit. */
export function todayCost(db: DB = getDb(), repoId?: number): number {
  const today = sql`strftime('%Y-%m-%d', ${jobs.startedAt}, 'unixepoch') = strftime('%Y-%m-%d', 'now')`;
  const row = db
    .select({
      total: sql<number>`coalesce(sum(${jobs.costUsd}), 0)`,
    })
    .from(jobs)
    .where(and(today, repoFilter(repoId)))
    .get();
  return row?.total ?? 0;
}
