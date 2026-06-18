import { and, asc, count, desc, eq, or, type SQL, sql } from "drizzle-orm";
import { type ClaudeUsageView, deriveClaudeUsageView } from "@/lib/agents/claude-usage";
import { providerLimitBlocked } from "@/lib/orchestrator/provider-limit";
import { getProviderUsage } from "@/lib/orchestrator/provider-usage";
import { type DB, getDb } from "./client";
import { todayCost } from "./cost-queries";
import { type Issue, issues, type Job, jobs, type Repo, repos } from "./schema";

export interface RepoWithStats extends Repo {
  activeJobs: number;
  queuedCount: number;
  workingCount: number;
  mergedCount: number;
  recentJobs: Job[];
}

export function listRepos(db: DB = getDb()): Repo[] {
  return db.select().from(repos).orderBy(desc(repos.createdAt)).all();
}

export function getRepo(id: number, db: DB = getDb()): Repo | undefined {
  return db.select().from(repos).where(eq(repos.id, id)).get();
}

export interface NeedsHumanJob extends Job {
  repoName: string;
}

/** Jobs parked in needs_human, newest first, enriched with their repo name. */
export function needsHumanJobs(db: DB = getDb()): NeedsHumanJob[] {
  return db
    .select()
    .from(jobs)
    .innerJoin(repos, eq(jobs.repoId, repos.id))
    .where(eq(jobs.status, "needs_human"))
    .orderBy(desc(jobs.finishedAt))
    .all()
    .map((r) => ({ ...r.jobs, repoName: r.repos.name }));
}

export function listReposWithStats(db: DB = getDb()): RepoWithStats[] {
  return listRepos(db).map((repo) => {
    const repoJobs = db
      .select()
      .from(jobs)
      .where(eq(jobs.repoId, repo.id))
      .orderBy(desc(jobs.createdAt))
      .all();
    const count = (statuses: string[]) =>
      repoJobs.filter((j) => statuses.includes(j.status)).length;
    return {
      ...repo,
      activeJobs: count(["queued", "working", "ci_running", "retrying"]),
      queuedCount: count(["queued"]),
      workingCount: count(["working", "ci_running", "retrying"]),
      mergedCount: count(["merged"]),
      recentJobs: repoJobs.slice(0, 5),
    };
  });
}

export interface RepoWorkspace {
  repo: Repo;
  issues: Issue[];
  activeJob: Job | undefined;
  recentJobs: Job[];
}

const ACTIVE = ["queued", "working", "ci_running", "retrying"];

export function getRepoWorkspace(repoId: number, db: DB = getDb()): RepoWorkspace | undefined {
  const repo = getRepo(repoId, db);
  if (!repo) return undefined;
  const repoIssues = db
    .select()
    .from(issues)
    .where(eq(issues.repoId, repoId))
    .orderBy(asc(issues.priority), asc(issues.number))
    .all();
  const repoJobs = db
    .select()
    .from(jobs)
    .where(eq(jobs.repoId, repoId))
    .orderBy(desc(jobs.createdAt))
    .all();
  const activeJob = repoJobs.find((j) => ACTIVE.includes(j.status));
  return { repo, issues: repoIssues, activeJob, recentJobs: repoJobs.slice(0, 8) };
}

export interface DashboardSummary {
  repos: number;
  queued: number;
  running: number;
  merged: number;
  needsHuman: number;
  spendToday: number;
}

/** Aggregate job counts across all repos for the dashboard stat cards. */
export function dashboardSummary(db: DB = getDb()): DashboardSummary {
  const allJobs = db.select().from(jobs).all();
  const count = (statuses: string[]) => allJobs.filter((j) => statuses.includes(j.status)).length;
  return {
    repos: db.select().from(repos).all().length,
    queued: count(["queued"]),
    running: count(["working", "ci_running", "retrying"]),
    merged: count(["merged"]),
    needsHuman: count(["needs_human"]),
    spendToday: todayCost(db),
  };
}

/** A single in-flight run surfaced on a repo's dashboard row. */
export interface InFlightJob {
  id: number;
  issueNumber: number;
  status: string;
}

/** One repo's live state for the at-a-glance multi-repo dashboard. */
export interface RepoDashboardRow {
  id: number;
  name: string;
  path: string;
  platform: string;
  queued: number;
  working: number;
  ciRunning: number;
  needsHuman: number;
  inFlight: InFlightJob[];
  lastActivityAt: number | null;
  todaySpend: number;
  /** The repo's configured daily cost cap (USD), for the combined budget gauge. */
  dailyLimitUsd: number;
  /** True when the repo has parked or failed work that wants a human. */
  attention: boolean;
}

export interface DashboardSnapshot {
  summary: DashboardSummary;
  repos: RepoDashboardRow[];
  /** Proactive Claude OAuth subscription-window indicator (issue #188). */
  claudeUsage: ClaudeUsageView;
}

/**
 * Render-ready Claude OAuth usage state for the navbar pill and dashboard card
 * (issue #188). Merges the last opportunistically-captured subscription-window
 * reading with any active provider-limit latch (the terminal parked state).
 */
export function getClaudeUsageView(db: DB = getDb()): ClaudeUsageView {
  const now = Math.floor(Date.now() / 1000);
  return deriveClaudeUsageView({
    reading: getProviderUsage("claude", db),
    latchedUntil: providerLimitBlocked("claude", db, now)?.blockedUntil,
    now,
  });
}

const IN_FLIGHT = ["working", "ci_running", "retrying"];

/** Most recent moment a repo did anything: finish, start, or enqueue. */
function jobActivity(job: Job): number {
  return job.finishedAt ?? job.startedAt ?? job.createdAt;
}

/**
 * Live snapshot of every watched repo for the parallel dashboard (issue #60):
 * per-status counts, in-flight runs, today's spend, and an attention flag.
 * Rows are ordered so repos needing a human surface first, then repos with
 * active work, then by most recent activity.
 */
export function dashboardSnapshot(db: DB = getDb()): DashboardSnapshot {
  const rows: RepoDashboardRow[] = listRepos(db).map((repo) => {
    const repoJobs = db
      .select()
      .from(jobs)
      .where(eq(jobs.repoId, repo.id))
      .orderBy(asc(jobs.createdAt))
      .all();
    const count = (statuses: string[]) =>
      repoJobs.filter((j) => statuses.includes(j.status)).length;
    const inFlight = repoJobs
      .filter((j) => IN_FLIGHT.includes(j.status))
      .map((j) => ({ id: j.id, issueNumber: j.issueNumber, status: j.status }));
    const lastActivityAt = repoJobs.length ? Math.max(...repoJobs.map(jobActivity)) : null;
    const needsHuman = count(["needs_human"]);
    const ciFailed = count(["ci_failed"]);
    return {
      id: repo.id,
      name: repo.name,
      path: repo.path,
      platform: repo.platform,
      queued: count(["queued"]),
      working: count(["working", "retrying"]),
      ciRunning: count(["ci_running"]),
      needsHuman,
      inFlight,
      lastActivityAt,
      todaySpend: todayCost(db, repo.id),
      dailyLimitUsd: repo.dailyCostLimitUsd,
      attention: needsHuman > 0 || ciFailed > 0,
    };
  });

  rows.sort((a, b) => {
    if (a.attention !== b.attention) return a.attention ? -1 : 1;
    const aActive = a.inFlight.length > 0;
    const bActive = b.inFlight.length > 0;
    if (aActive !== bActive) return aActive ? -1 : 1;
    const aSeen = a.lastActivityAt ?? 0;
    const bSeen = b.lastActivityAt ?? 0;
    if (aSeen !== bSeen) return bSeen - aSeen;
    return a.name.localeCompare(b.name);
  });

  return { summary: dashboardSummary(db), repos: rows, claudeUsage: getClaudeUsageView(db) };
}

export interface JobHistoryFilters {
  repoId?: number;
  status?: string;
  model?: string;
  /** Free-text search: matches issue number (exact) or issue title (substring). */
  search?: string;
  /** 1-based page number. */
  page?: number;
  pageSize?: number;
}

export interface JobHistoryRow extends Job {
  repoName: string;
  issueTitle: string | null;
}

export interface JobHistoryPage {
  rows: JobHistoryRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

const DEFAULT_PAGE_SIZE = 25;

/**
 * Paginated cross-repo job history with optional filters and free-text search.
 * Rows are ordered newest-first by createdAt. Searching matches exact issue
 * number or a case-insensitive issue title substring via the issues cache.
 */
export function listJobsPage(filters: JobHistoryFilters, db: DB = getDb()): JobHistoryPage {
  const pageSize = filters.pageSize ?? DEFAULT_PAGE_SIZE;

  const conditions: SQL[] = [];
  if (filters.repoId !== undefined) conditions.push(eq(jobs.repoId, filters.repoId));
  if (filters.status) conditions.push(eq(jobs.status, filters.status));
  if (filters.model) conditions.push(eq(jobs.model, filters.model));

  if (filters.search?.trim()) {
    const term = filters.search.trim();
    const asNumber = Number(term);
    if (!Number.isNaN(asNumber) && Number.isInteger(asNumber) && String(asNumber) === term) {
      conditions.push(eq(jobs.issueNumber, asNumber));
    } else {
      // Escape LIKE wildcards so a literal search for "100%" or "re_name"
      // matches only those characters. The term stays a bound parameter;
      // drizzle's like() has no escape support, hence the sql fragments.
      const pattern = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
      conditions.push(
        or(
          sql`${issues.title} LIKE ${pattern} ESCAPE '\\'`,
          sql`LOWER(${issues.title}) LIKE LOWER(${pattern}) ESCAPE '\\'`,
        ) as SQL,
      );
    }
  }

  const where = conditions.length ? and(...conditions) : undefined;

  const totalResult = db
    .select({ n: count() })
    .from(jobs)
    .leftJoin(issues, and(eq(issues.repoId, jobs.repoId), eq(issues.number, jobs.issueNumber)))
    .innerJoin(repos, eq(repos.id, jobs.repoId))
    .where(where)
    .get();

  const total = totalResult?.n ?? 0;
  const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);

  // Clamp requested page to valid range.
  const requestedPage = filters.page ?? 1;
  const page = total === 0 ? 1 : Math.min(Math.max(1, requestedPage), Math.max(1, totalPages));
  const offset = (page - 1) * pageSize;

  const raw = db
    .select({
      job: jobs,
      repoName: repos.name,
      issueTitle: issues.title,
    })
    .from(jobs)
    .leftJoin(issues, and(eq(issues.repoId, jobs.repoId), eq(issues.number, jobs.issueNumber)))
    .innerJoin(repos, eq(repos.id, jobs.repoId))
    .where(where)
    .orderBy(desc(jobs.createdAt))
    .limit(pageSize)
    .offset(offset)
    .all();

  const rows: JobHistoryRow[] = raw.map((r) => ({
    ...r.job,
    repoName: r.repoName,
    issueTitle: r.issueTitle ?? null,
  }));

  return { rows, total, page, pageSize, totalPages };
}
