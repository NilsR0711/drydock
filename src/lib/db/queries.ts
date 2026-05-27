import { asc, desc, eq } from "drizzle-orm";
import { type DB, getDb } from "./client";
import { type Issue, type Job, type Repo, issues, jobs, repos } from "./schema";

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
