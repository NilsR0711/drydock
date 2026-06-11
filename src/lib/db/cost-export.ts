import { and, desc, eq, type SQL, sql } from "drizzle-orm";
import { type DB, getDb } from "./client";
import { jobs, oneShotCosts, repos } from "./schema";

/** The aggregation shape of an export (issue #63). */
export type CostReport = "line-items" | "by-repo" | "by-model";

/** Serialization format of an export. */
export type CostExportFormat = "csv" | "json";

export interface CostExportFilter {
  /** Inclusive lower-bound day (local), `YYYY-MM-DD`. Omit for no lower bound. */
  from?: string;
  /** Inclusive upper-bound day (local), `YYYY-MM-DD`. Omit for no upper bound. */
  to?: string;
  /** Restrict to a single repo. Omit for fleet-wide totals. */
  repoId?: number;
}

/** A serialization-ready table: ordered column keys + plain row records. */
export interface CostExportTable {
  report: CostReport;
  columns: string[];
  rows: Array<Record<string, string | number>>;
}

// Cost is a SQLite `real`; summing floats accrues representation noise. Round to
// micro-dollars so exported figures are clean yet lossless against the
// 4-decimal dashboard display.
const roundCost = (n: number): number => Math.round(n * 1_000_000) / 1_000_000;

// The day a job is attributed to, in local time — identical to the dashboard's
// daily grouping (see cost-queries.ts), so exported totals reconcile with it.
const dayExpr = sql<string>`strftime('%Y-%m-%d', ${jobs.startedAt}, 'unixepoch', 'localtime')`;

// Shared base predicate. A job needs a start date to belong to any date bucket;
// undated jobs (e.g. still queued) carry no realized cost to report and are
// excluded so every report shares one job set and their totals reconcile.
function baseConditions(filter: CostExportFilter): SQL[] {
  const conds: SQL[] = [sql`${jobs.startedAt} is not null`];
  if (filter.repoId !== undefined) conds.push(sql`${jobs.repoId} = ${filter.repoId}`);
  if (filter.from) conds.push(sql`${dayExpr} >= ${filter.from}`);
  if (filter.to) conds.push(sql`${dayExpr} <= ${filter.to}`);
  return conds;
}

// One-shot agent calls (decompose, release, verify, …) are counted by the cost
// dashboard and the daily budget (see cost-queries.ts), so the exports fold
// them in too — otherwise exported totals would silently undercount and could
// never reconcile with the dashboard. They surface under a `one-shot:<type>`
// model label since the ledger records no model.
const oneShotDayExpr = sql<string>`strftime('%Y-%m-%d', ${oneShotCosts.createdAt}, 'unixepoch', 'localtime')`;
const oneShotModelExpr = sql<string>`'one-shot:' || ${oneShotCosts.type}`;

function oneShotConditions(filter: CostExportFilter): SQL[] {
  const conds: SQL[] = [];
  if (filter.repoId !== undefined) conds.push(sql`${oneShotCosts.repoId} = ${filter.repoId}`);
  if (filter.from) conds.push(sql`${oneShotDayExpr} >= ${filter.from}`);
  if (filter.to) conds.push(sql`${oneShotDayExpr} <= ${filter.to}`);
  return conds;
}

const costSum = sql<number>`coalesce(sum(${jobs.costUsd}), 0)`;
const inputSum = sql<number>`coalesce(sum(${jobs.totalInputTokens}), 0)`;
const outputSum = sql<number>`coalesce(sum(${jobs.totalOutputTokens}), 0)`;
const modelExpr = sql<string>`coalesce(${jobs.model}, 'unknown')`;

function lineItems(db: DB, filter: CostExportFilter): CostExportTable {
  const jobRows = db
    .select({
      sortKey: jobs.startedAt,
      date: dayExpr,
      repo: repos.name,
      issue: jobs.issueNumber,
      job_id: jobs.id,
      model: modelExpr,
      input_tokens: jobs.totalInputTokens,
      output_tokens: jobs.totalOutputTokens,
      total_cost_usd: jobs.costUsd,
    })
    .from(jobs)
    .innerJoin(repos, eq(jobs.repoId, repos.id))
    .where(and(...baseConditions(filter)))
    .orderBy(desc(jobs.startedAt), desc(jobs.id))
    .all();
  // One-shot calls have no issue/job; those cells stay empty in the export.
  const oneShotRows = db
    .select({
      sortKey: oneShotCosts.createdAt,
      date: oneShotDayExpr,
      repo: repos.name,
      model: oneShotModelExpr,
      input_tokens: oneShotCosts.inputTokens,
      output_tokens: oneShotCosts.outputTokens,
      total_cost_usd: oneShotCosts.costUsd,
    })
    .from(oneShotCosts)
    .innerJoin(repos, eq(oneShotCosts.repoId, repos.id))
    .where(and(...oneShotConditions(filter)))
    .orderBy(desc(oneShotCosts.createdAt), desc(oneShotCosts.id))
    .all();
  type LineItem = { sortKey: number; row: Record<string, string | number> };
  const merged: LineItem[] = [
    ...jobRows.map(({ sortKey, ...row }) => ({
      sortKey: sortKey ?? 0,
      row: { ...row, total_cost_usd: roundCost(row.total_cost_usd) },
    })),
    ...oneShotRows.map(({ sortKey, ...row }) => ({
      sortKey,
      row: { ...row, issue: "", job_id: "", total_cost_usd: roundCost(row.total_cost_usd) },
    })),
  ].sort((a, b) => b.sortKey - a.sortKey);
  return {
    report: "line-items",
    columns: [
      "date",
      "repo",
      "issue",
      "job_id",
      "model",
      "input_tokens",
      "output_tokens",
      "total_cost_usd",
    ],
    rows: merged.map((m) => m.row),
  };
}

function byRepo(db: DB, filter: CostExportFilter): CostExportTable {
  const jobRows = db
    .select({
      repo_id: jobs.repoId,
      repo: repos.name,
      jobs: sql<number>`count(*)`,
      input_tokens: inputSum,
      output_tokens: outputSum,
      total_cost_usd: costSum,
    })
    .from(jobs)
    .innerJoin(repos, eq(jobs.repoId, repos.id))
    .where(and(...baseConditions(filter)))
    .groupBy(jobs.repoId)
    .all();
  const oneShotRows = db
    .select({
      repo_id: oneShotCosts.repoId,
      repo: repos.name,
      input_tokens: sql<number>`coalesce(sum(${oneShotCosts.inputTokens}), 0)`,
      output_tokens: sql<number>`coalesce(sum(${oneShotCosts.outputTokens}), 0)`,
      total_cost_usd: sql<number>`coalesce(sum(${oneShotCosts.costUsd}), 0)`,
    })
    .from(oneShotCosts)
    .innerJoin(repos, eq(oneShotCosts.repoId, repos.id))
    .where(and(...oneShotConditions(filter)))
    .groupBy(oneShotCosts.repoId)
    .all();
  // Merge one-shot spend into the per-repo job aggregates. The `jobs` column
  // counts jobs only — one-shot calls add tokens and cost, not job count.
  type RepoRow = {
    repo: string;
    jobs: number;
    input_tokens: number;
    output_tokens: number;
    total_cost_usd: number;
  };
  const byId = new Map<number, RepoRow>();
  for (const { repo_id, ...row } of jobRows) byId.set(repo_id, row);
  for (const { repo_id, ...row } of oneShotRows) {
    const entry = byId.get(repo_id) ?? {
      repo: row.repo,
      jobs: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_cost_usd: 0,
    };
    entry.input_tokens += row.input_tokens;
    entry.output_tokens += row.output_tokens;
    entry.total_cost_usd += row.total_cost_usd;
    byId.set(repo_id, entry);
  }
  const rows = [...byId.values()].sort((a, b) => b.total_cost_usd - a.total_cost_usd);
  return {
    report: "by-repo",
    columns: ["repo", "jobs", "input_tokens", "output_tokens", "total_cost_usd"],
    rows: rows.map((r) => ({ ...r, total_cost_usd: roundCost(r.total_cost_usd) })),
  };
}

function byModel(db: DB, filter: CostExportFilter): CostExportTable {
  const jobRows = db
    .select({
      model: modelExpr,
      jobs: sql<number>`count(*)`,
      input_tokens: inputSum,
      output_tokens: outputSum,
      total_cost_usd: costSum,
    })
    .from(jobs)
    .where(and(...baseConditions(filter)))
    .groupBy(modelExpr)
    .all();
  // One-shot spend surfaces as dedicated `one-shot:<type>` buckets. Their
  // `jobs` column is 0: one-shot calls are not jobs, only tokens and cost.
  const oneShotRows = db
    .select({
      model: oneShotModelExpr,
      input_tokens: sql<number>`coalesce(sum(${oneShotCosts.inputTokens}), 0)`,
      output_tokens: sql<number>`coalesce(sum(${oneShotCosts.outputTokens}), 0)`,
      total_cost_usd: sql<number>`coalesce(sum(${oneShotCosts.costUsd}), 0)`,
    })
    .from(oneShotCosts)
    .where(and(...oneShotConditions(filter)))
    .groupBy(oneShotCosts.type)
    .all();
  const rows = [...jobRows, ...oneShotRows.map((r) => ({ ...r, jobs: 0 }))].sort(
    (a, b) => b.total_cost_usd - a.total_cost_usd,
  );
  return {
    report: "by-model",
    columns: ["model", "jobs", "input_tokens", "output_tokens", "total_cost_usd"],
    rows: rows.map((r) => ({ ...r, total_cost_usd: roundCost(r.total_cost_usd) })),
  };
}

/**
 * Build a serialization-ready cost export for the given report and filter.
 * Reports share one underlying spend set (dated jobs plus one-shot agent calls
 * matching the filter) so their grand totals reconcile with each other and
 * with the cost dashboard, which folds one-shot spend in the same way.
 */
export function buildCostExport(
  report: CostReport,
  filter: CostExportFilter = {},
  db: DB = getDb(),
): CostExportTable {
  switch (report) {
    case "line-items":
      return lineItems(db, filter);
    case "by-repo":
      return byRepo(db, filter);
    case "by-model":
      return byModel(db, filter);
  }
}

// RFC 4180: quote a field that contains a comma, quote, CR or LF; escape inner
// quotes by doubling them.  Additionally prefix spreadsheet formula triggers
// (= + - @ tab) with a leading apostrophe so spreadsheet apps treat the cell
// as plain text rather than evaluating it as a formula (CSV injection defence).
function csvField(value: string | number): string {
  const s = String(value);
  const safe = /^[=+\-@\t]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Serialize a table as RFC-4180 CSV (CRLF line endings, trailing newline). */
export function toCsv(table: CostExportTable): string {
  const header = table.columns.map(csvField).join(",");
  const body = table.rows.map((row) =>
    table.columns.map((col) => csvField(row[col] ?? "")).join(","),
  );
  return `${[header, ...body].join("\r\n")}\r\n`;
}

/** Serialize a table's rows as a pretty-printed JSON array of objects. */
export function toJson(table: CostExportTable): string {
  return JSON.stringify(table.rows, null, 2);
}
