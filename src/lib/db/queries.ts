import { desc, eq } from "drizzle-orm";
import { type DB, getDb } from "./client";
import { type Job, type Repo, jobs, repos } from "./schema";

export interface RepoWithStats extends Repo {
  activeJobs: number;
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
    const active = repoJobs.filter((j) =>
      ["queued", "working", "ci_running", "retrying"].includes(j.status),
    ).length;
    return { ...repo, activeJobs: active, recentJobs: repoJobs.slice(0, 5) };
  });
}
