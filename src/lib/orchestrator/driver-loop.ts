import { and, eq } from "drizzle-orm";
import { type DB, getDb } from "@/lib/db/client";
import { listRepos } from "@/lib/db/queries";
import { issues, type Job } from "@/lib/db/schema";
import { GhClient, type GhIssue } from "@/lib/github/gh";
import { evaluateIssue } from "@/lib/issues/evaluator";
import { syncIssuesFromGh } from "@/lib/issues/service";
import { getSettings, jobsAllowed, repoJobsAllowed } from "@/lib/settings/service";
import { createJob, listJobsByStatus, nextQueuedJob, transitionJob } from "./jobs";
import { runJob as defaultRunJob } from "./run-job";
import { activeJobCount, isDraining, registerActiveJob, unregisterActiveJob } from "./runtime";

export interface DriveTickDeps {
  db?: DB;
  fetchIssues?: (repoPath: string, label: string) => Promise<GhIssue[]>;
  runJob?: (jobId: number) => Promise<Job>;
}

const OPEN_STATES = ["queued", "working", "ci_running", "ci_failed", "retrying"] as const;
// Non-terminal, already-started states. A repo with any such job is "in flight":
// for sequential repos the next issue waits until this clears (merged/needs_human/aborted).
const IN_FLIGHT_STATES = ["working", "ci_running", "ci_failed", "retrying"] as const;

function hasOpenJob(db: DB, repoId: number, issueNumber: number): boolean {
  return listJobsByStatus([...OPEN_STATES], db).some(
    (j) => j.repoId === repoId && j.issueNumber === issueNumber,
  );
}

function repoHasInFlightJob(db: DB, repoId: number): boolean {
  return listJobsByStatus([...IN_FLIGHT_STATES], db).some((j) => j.repoId === repoId);
}

function issuePriority(db: DB, repoId: number, issueNumber: number): number {
  const row = db
    .select({ p: issues.priority })
    .from(issues)
    .where(and(eq(issues.repoId, repoId), eq(issues.number, issueNumber)))
    .get();
  return row?.p ?? Number.POSITIVE_INFINITY;
}

function lessUrgent(db: DB, a: Job, b: Job): boolean {
  const pa = issuePriority(db, a.repoId, a.issueNumber);
  const pb = issuePriority(db, b.repoId, b.issueNumber);
  if (pa !== pb) return pa > pb;
  return a.createdAt > b.createdAt;
}

/**
 * One scheduler tick: sync labelled issues into approved jobs, then start the
 * globally highest-priority queued jobs until the parallel budget or a gate is
 * hit. Per-repo and per-job failures are isolated so the loop keeps running.
 */
export async function driveTick(deps: DriveTickDeps = {}): Promise<void> {
  const db = deps.db ?? getDb();
  const runJob = deps.runJob ?? defaultRunJob;
  const repos = listRepos(db);

  for (const repo of repos) {
    try {
      const fetch = deps.fetchIssues ?? ((p, _label) => new GhClient(p).listAllIssues());
      const fetched = await fetch(repo.path, repo.queueLabel);
      syncIssuesFromGh(repo.id, fetched, db);
      for (const gh of fetched) {
        const labelNames = gh.labels.map((l) => l.name);
        if (!labelNames.includes(repo.queueLabel)) continue; // backlog issues aren't scheduled
        const verdict = evaluateIssue({
          number: gh.number,
          title: gh.title,
          labels: labelNames,
        });
        if (verdict.decision !== "approved") continue;
        if (hasOpenJob(db, repo.id, gh.number)) continue;
        createJob({ repoId: repo.id, issueNumber: gh.number, model: repo.defaultModel }, db);
      }
    } catch (err) {
      console.error(`[driver] issue sync failed for ${repo.name}`, err);
    }
  }

  const max = getSettings(db).maxParallelJobs;
  // Sequential repos may start at most one job per tick; track those started here
  // so a second queued issue for the same repo isn't picked before its job leaves
  // "queued" within this same loop.
  const startedSequentialRepos = new Set<number>();
  while (!isDraining() && jobsAllowed(db).allowed && activeJobCount() < max) {
    let picked: Job | undefined;
    for (const repo of repos) {
      if (!repoJobsAllowed(repo.id, db).allowed) continue;
      if (
        repo.sequential &&
        (repoHasInFlightJob(db, repo.id) || startedSequentialRepos.has(repo.id))
      )
        continue;
      const candidate = nextQueuedJob(repo.id, db);
      if (candidate && (!picked || lessUrgent(db, picked, candidate))) picked = candidate;
    }
    if (!picked) break;
    const job = picked;

    const repoOfPicked = repos.find((r) => r.id === job.repoId);
    if (repoOfPicked?.sequential) startedSequentialRepos.add(job.repoId);

    const jobId = job.id;
    // Claim it out of "queued" synchronously so it isn't re-picked next turn.
    // (The working-state guard in claude-session keeps spawnClaudeSession happy.)
    transitionJob(jobId, "working", {}, db);
    registerActiveJob(jobId);
    void runJob(jobId)
      .catch((err) => console.error(`[driver] job ${jobId} failed`, err))
      .finally(() => unregisterActiveJob(jobId));
  }
}

let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;
let ticking = false;

export interface StartLoopOptions {
  intervalMs?: number;
  tick?: () => Promise<void>;
}

/**
 * Start the self-scheduling driver loop. Idempotent. An immediate tick runs,
 * then one every intervalMs. Overlapping ticks are skipped via a re-entrancy
 * guard. Default interval comes from settings.pollIntervalSec.
 */
export function startDriverLoop(opts: StartLoopOptions = {}): void {
  if (running) return;
  running = true;
  const tick = opts.tick ?? (() => driveTick());
  const intervalMs = opts.intervalMs ?? getSettings().pollIntervalSec * 1000;

  const schedule = () => {
    timer = setTimeout(run, intervalMs);
  };
  const run = async () => {
    if (!running) return;
    if (!ticking) {
      ticking = true;
      try {
        await tick();
      } catch (err) {
        console.error("[driver] tick failed", err);
      } finally {
        ticking = false;
      }
    }
    if (running) schedule();
  };
  void run(); // immediate first tick
}

export function stopDriverLoop(): void {
  running = false;
  if (timer) clearTimeout(timer);
  timer = undefined;
}
