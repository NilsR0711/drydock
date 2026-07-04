import { and, asc, count, desc, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import { type ClaudeUsageView, deriveClaudeUsageView } from "@/lib/agents/claude-usage";
import { buildCodexUsageView, type CodexUsageView } from "@/lib/agents/codex-usage";
import { deriveGithubBudgetView, type GithubBudgetView } from "@/lib/github/budget-view";
import { sharedGovernor } from "@/lib/github/rate-limit";
import { providerLimitBlocked } from "@/lib/orchestrator/provider-limit";
import { getCodexUsage, getProviderUsage } from "@/lib/orchestrator/provider-usage";
import { type DB, getDb } from "./client";
import { todayCost, todaySpendByRepo } from "./cost-queries";
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

/** Statuses that count as "running" in the summary's running tally. */
const RUNNING = ["working", "ci_running", "retrying"] as const;

/** Fold a status→count map into the dashboard stat-card summary shape. */
function summarize(
  statusCounts: Map<string, number>,
  repoCount: number,
  spendToday: number,
): DashboardSummary {
  const total = (statuses: readonly string[]) =>
    statuses.reduce((sum, s) => sum + (statusCounts.get(s) ?? 0), 0);
  return {
    repos: repoCount,
    queued: total(["queued"]),
    running: total(RUNNING),
    merged: total(["merged"]),
    needsHuman: total(["needs_human"]),
    spendToday,
  };
}

/**
 * Aggregate job counts across all repos for the dashboard stat cards. Counts
 * come from a single `GROUP BY status` aggregate rather than materializing the
 * whole (forever-growing) jobs table into JS (issue #415).
 */
export function dashboardSummary(db: DB = getDb()): DashboardSummary {
  const statusCounts = new Map<string, number>();
  for (const row of db
    .select({ status: jobs.status, n: count() })
    .from(jobs)
    .groupBy(jobs.status)
    .all()) {
    statusCounts.set(row.status, row.n);
  }
  const repoCount = db.select({ n: count() }).from(repos).get()?.n ?? 0;
  return summarize(statusCounts, repoCount, todayCost(db));
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

/** A parked job, named for the live dashboard's needs_human alert (issue #258). */
export interface NeedsHumanJobRef {
  id: number;
  repoName: string;
  issueNumber: number;
}

export interface DashboardSnapshot {
  summary: DashboardSummary;
  repos: RepoDashboardRow[];
  /**
   * Jobs currently parked in needs_human (newest first). The live dashboard
   * diffs successive snapshots by id to fire a one-shot sound + toast the
   * moment a new job crosses the edge (issue #258).
   */
  needsHumanJobs: NeedsHumanJobRef[];
  /** Proactive Claude OAuth subscription-window indicator (issue #188). */
  claudeUsage: ClaudeUsageView;
  /** Proactive Codex OAuth quota indicator (issue #189). */
  codexUsage: CodexUsageView;
  /** Proactive GitHub API rate-limit budget indicator (issue #408). */
  githubBudget: GithubBudgetView;
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

/**
 * Render-ready Codex OAuth usage state for the navbar pill and dashboard card
 * (issue #189). Merges the last captured `rate_limits` snapshot with any active
 * provider-limit latch (the terminal parked state).
 */
export function getCodexUsageView(db: DB = getDb()): CodexUsageView {
  const now = Math.floor(Date.now() / 1000);
  return buildCodexUsageView({
    snapshot: getCodexUsage(db),
    latchedUntil: providerLimitBlocked("codex", db, now)?.blockedUntil,
    now,
  });
}

/**
 * Render-ready GitHub API rate-limit budget for the navbar pill and dashboard
 * card (issue #408). Read straight from the shared governor's last-observed
 * snapshots — process memory, no DB and no forge call — so it reflects the same
 * back-pressure the governor applies to background sweeps.
 */
export function getGithubBudgetView(): GithubBudgetView {
  return deriveGithubBudgetView({
    core: sharedGovernor.budget("core"),
    graphql: sharedGovernor.budget("graphql"),
  });
}

const IN_FLIGHT = ["working", "ci_running", "retrying"];

/**
 * Live snapshot of every watched repo for the parallel dashboard (issue #60):
 * per-status counts, in-flight runs, today's spend, and an attention flag.
 * Rows are ordered so repos needing a human surface first, then repos with
 * active work, then by most recent activity.
 *
 * All per-repo tallies come from a handful of grouped SQL aggregates over the
 * jobs table rather than materializing every job row per repo (issue #415):
 * a single `GROUP BY repo_id, status` feeds both the per-repo counts and the
 * global summary, `MAX(COALESCE(...))` gives each repo's last activity, a
 * narrow `status IN (...)` select lists in-flight runs, and today's spend is
 * one grouped query per cost table — so the snapshot cost no longer scales with
 * the forever-growing jobs table.
 */
export function dashboardSnapshot(db: DB = getDb()): DashboardSnapshot {
  // One grouped scan feeds both the per-repo counts and the global summary.
  const countsByRepo = new Map<number, Map<string, number>>();
  const globalCounts = new Map<string, number>();
  for (const { repoId, status, n } of db
    .select({ repoId: jobs.repoId, status: jobs.status, n: count() })
    .from(jobs)
    .groupBy(jobs.repoId, jobs.status)
    .all()) {
    let byStatus = countsByRepo.get(repoId);
    if (!byStatus) {
      byStatus = new Map();
      countsByRepo.set(repoId, byStatus);
    }
    byStatus.set(status, n);
    globalCounts.set(status, (globalCounts.get(status) ?? 0) + n);
  }

  const activityByRepo = new Map<number, number>();
  for (const { repoId, lastActivityAt } of db
    .select({
      repoId: jobs.repoId,
      lastActivityAt: sql<
        number | null
      >`max(coalesce(${jobs.finishedAt}, ${jobs.startedAt}, ${jobs.createdAt}))`,
    })
    .from(jobs)
    .groupBy(jobs.repoId)
    .all()) {
    if (lastActivityAt != null) activityByRepo.set(repoId, lastActivityAt);
  }

  // Narrow projection ordered oldest-first, matching the previous per-repo scan.
  const inFlightByRepo = new Map<number, InFlightJob[]>();
  for (const { id, repoId, issueNumber, status } of db
    .select({
      id: jobs.id,
      repoId: jobs.repoId,
      issueNumber: jobs.issueNumber,
      status: jobs.status,
    })
    .from(jobs)
    .where(inArray(jobs.status, IN_FLIGHT))
    .orderBy(asc(jobs.createdAt), asc(jobs.id))
    .all()) {
    const list = inFlightByRepo.get(repoId);
    if (list) list.push({ id, issueNumber, status });
    else inFlightByRepo.set(repoId, [{ id, issueNumber, status }]);
  }

  const spendByRepo = todaySpendByRepo(db);

  const repoList = listRepos(db);
  const rows: RepoDashboardRow[] = repoList.map((repo) => {
    const counts = countsByRepo.get(repo.id);
    const c = (statuses: readonly string[]) =>
      statuses.reduce((sum, s) => sum + (counts?.get(s) ?? 0), 0);
    const needsHuman = c(["needs_human"]);
    const ciFailed = c(["ci_failed"]);
    return {
      id: repo.id,
      name: repo.name,
      path: repo.path,
      platform: repo.platform,
      queued: c(["queued"]),
      working: c(["working", "retrying"]),
      ciRunning: c(["ci_running"]),
      needsHuman,
      inFlight: inFlightByRepo.get(repo.id) ?? [],
      lastActivityAt: activityByRepo.get(repo.id) ?? null,
      todaySpend: spendByRepo.get(repo.id) ?? 0,
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

  // The per-repo spend already sums to the global total, so reuse it instead of
  // re-scanning for a separate `todayCost(db)`.
  const spendToday = [...spendByRepo.values()].reduce((sum, n) => sum + n, 0);

  return {
    summary: summarize(globalCounts, repoList.length, spendToday),
    repos: rows,
    needsHumanJobs: needsHumanJobs(db).map((j) => ({
      id: j.id,
      repoName: j.repoName,
      issueNumber: j.issueNumber,
    })),
    claudeUsage: getClaudeUsageView(db),
    codexUsage: getCodexUsageView(db),
    githubBudget: getGithubBudgetView(),
  };
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
 * Rows are ordered newest-first by createdAt, with id (insertion order) as a
 * deterministic tiebreaker for jobs enqueued within the same second. Searching
 * matches exact issue number or a case-insensitive issue title substring via
 * the issues cache.
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
    // createdAt is stored at one-second granularity, so bulk enqueues share a
    // timestamp. id (autoincrement) is the monotonic insertion order and acts as
    // a deterministic tiebreaker, keeping the history a stable processing-order
    // timeline regardless of status.
    .orderBy(desc(jobs.createdAt), desc(jobs.id))
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
