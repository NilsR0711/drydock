import { and, eq } from "drizzle-orm";
import { type DB, getDb } from "@/lib/db/client";
import { listRepos } from "@/lib/db/queries";
import { type Job, jobEvents, jobs as jobsTable, type Repo } from "@/lib/db/schema";
import { getForge } from "@/lib/forge/registry";
import type { ForgeClient } from "@/lib/forge/types";
import { logError } from "@/lib/log/logger";
import { getJob, listJobs, recordEvent, transitionJob } from "./jobs";
import { markIssueNeedsHuman } from "./needs-human";
import { InvalidTransitionError } from "./state-machine";

/**
 * Background janitor for Drydock's remote branches and open PRs (issue #181):
 * one sweep per driver tick, per repo. It deletes the remote branch of merged
 * Drydock PRs (the `--delete-branch` equivalent the auto-merge never performs),
 * updates open PRs that fell behind the default branch while conflict-free, and
 * escalates conflicted PRs to `needs_human` with an explicit rebase reason —
 * instead of letting CI polling time out with a confusing message.
 *
 * Safety invariant: only branches with the {@link DRYDOCK_BRANCH_PREFIX} are
 * ever deleted or updated; everything else is invisible to the janitor.
 */

/** Branch namespace owned by Drydock; the janitor never touches anything else. */
export const DRYDOCK_BRANCH_PREFIX = "drydock/";

/** Job-event type stamped when a merged job's remote branch has been deleted,
 * so the cleanup is idempotent across sweeps and process restarts. */
const JANITOR_EVENT = "janitor";

/** Job states whose PR is open and still owned by automation. Parked states
 * (needs_human/interrupted) are deliberately excluded — their PRs wait on an
 * operator — as is waiting_limit, which resumes its own session. */
const REFRESH_STATES = new Set(["ci_running", "ci_failed", "retrying"]);

export interface JanitorDeps {
  db?: DB;
  forgeFor?: (repo: Repo) => ForgeClient;
}

/** Whether the job's branch is inside the Drydock-owned namespace. */
function isDrydockBranch(branch: string | null): branch is string {
  return branch?.startsWith(DRYDOCK_BRANCH_PREFIX) ?? false;
}

/** This repo's job ids whose merged branch was already deleted by a prior
 * sweep. Scoped to the repo via a join so the lookup stays proportional to one
 * repo's history instead of every repo's, as the event log grows. */
function cleanedJobIds(repoId: number, db: DB): Set<number> {
  const rows = db
    .select({ jobId: jobEvents.jobId, payload: jobEvents.payload })
    .from(jobEvents)
    .innerJoin(jobsTable, eq(jobEvents.jobId, jobsTable.id))
    .where(and(eq(jobEvents.type, JANITOR_EVENT), eq(jobsTable.repoId, repoId)))
    .all();
  const cleaned = new Set<number>();
  for (const row of rows) {
    try {
      if (JSON.parse(row.payload ?? "{}").action === "branch_deleted") cleaned.add(row.jobId);
    } catch {
      // An unreadable stamp is treated as absent; the delete retries (no-op).
    }
  }
  return cleaned;
}

/**
 * Delete the remote branches of this repo's merged Drydock PRs. Each deletion
 * is stamped as a job event so later sweeps skip it; a failed delete stays
 * unstamped and is retried next sweep. A branch still referenced by a live
 * (non-terminal) job is never deleted, however unlikely the collision.
 */
async function cleanupMergedBranches(
  repoId: number,
  jobs: Job[],
  forge: ForgeClient,
  db: DB,
): Promise<void> {
  if (typeof forge.deleteBranch !== "function") return;
  const cleaned = cleanedJobIds(repoId, db);
  const liveBranches = new Set(
    jobs
      .filter((j) => !["merged", "released", "aborted"].includes(j.status))
      .map((j) => j.branch)
      .filter(isDrydockBranch),
  );
  const candidates = jobs.filter(
    (j) =>
      j.status === "merged" &&
      j.prNumber !== null &&
      isDrydockBranch(j.branch) &&
      !cleaned.has(j.id) &&
      !liveBranches.has(j.branch),
  );
  for (const job of candidates) {
    const branch = job.branch as string;
    try {
      await forge.deleteBranch(branch);
      recordEvent(job.id, JANITOR_EVENT, { action: "branch_deleted", branch }, db);
    } catch (err) {
      logError(`[janitor] branch delete failed for job ${job.id} (${branch})`, err);
    }
  }
}

/**
 * Probe this repo's open Drydock PRs: a behind-but-clean PR gets its branch
 * updated (so the merge gate sees a current head instead of a stale one), a
 * conflicted PR escalates its job to `needs_human` with an explicit rebase
 * reason. Clean and not-yet-computed states are left alone.
 */
async function refreshOpenPrs(repo: Repo, jobs: Job[], forge: ForgeClient, db: DB): Promise<void> {
  if (typeof forge.prMergeState !== "function") return;
  const candidates = jobs.filter(
    (j) => REFRESH_STATES.has(j.status) && j.prNumber !== null && isDrydockBranch(j.branch),
  );
  for (const job of candidates) {
    const prNumber = job.prNumber as number;
    try {
      const state = await forge.prMergeState(prNumber);
      if (state === "behind" && typeof forge.updatePrBranch === "function") {
        await forge.updatePrBranch(prNumber);
        recordEvent(job.id, JANITOR_EVENT, { action: "branch_updated", prNumber }, db);
      } else if (state === "conflicted") {
        await escalateConflict(repo, job, prNumber, forge, db);
      }
    } catch (err) {
      logError(`[janitor] PR refresh failed for job ${job.id} (PR #${prNumber})`, err);
    }
  }
}

/** Park the job for a human with the rebase reason; the comment is best-effort
 * and the transition tolerates a concurrent settle (merge/abort) of the job. */
async function escalateConflict(
  repo: Repo,
  job: Job,
  prNumber: number,
  forge: ForgeClient,
  db: DB,
): Promise<void> {
  const reason = `rebase needed: conflicts with ${repo.defaultBranch}`;
  try {
    await forge.commentIssue(
      job.issueNumber,
      `⚠️ PR #${prNumber} conflicts with \`${repo.defaultBranch}\` — a rebase is needed. ` +
        `Parking job #${job.id} for a human.`,
    );
  } catch (err) {
    logError(`[janitor] conflict comment failed for job ${job.id}`, err);
  }
  try {
    // Re-check freshness right before the transition: the babysitter may have
    // merged or an operator aborted the job while the probe was in flight.
    const fresh = getJob(job.id, db);
    if (!fresh || !REFRESH_STATES.has(fresh.status)) return;
    // Deliberate pair of status events: transitionJob logs the generic
    // {from, to} entry, while this one carries the *why* (reason + PR) for the
    // job timeline — same pattern as the CI babysitter and limit-resume paths.
    recordEvent(job.id, "status", { reason: "merge_conflict", prNumber }, db);
    transitionJob(job.id, "needs_human", { errorMessage: reason }, db);
    // Make the park visible on the issue (issue #250): needs-human label +
    // drop the queue label. The richer rebase comment above stays as the
    // reason, so this only manages labels. Best-effort and never throws.
    await markIssueNeedsHuman(repo, job.issueNumber, forge, db);
  } catch (err) {
    // A racing transition between the freshness check and ours is benign.
    if (!(err instanceof InvalidTransitionError)) throw err;
  }
}

/**
 * One janitor sweep across every repo. Per-repo failures are isolated so one
 * unreachable forge never stalls the others; per-job failures are isolated
 * inside the two steps. Designed to run at driver-loop cadence under `low`
 * rate-limit priority, like the other background sweeps.
 */
export async function runBranchJanitorSweep(deps: JanitorDeps = {}): Promise<void> {
  const db = deps.db ?? getDb();
  for (const repo of listRepos(db)) {
    try {
      const forge = deps.forgeFor?.(repo) ?? getForge(repo);
      const jobs = listJobs(repo.id, db);
      await cleanupMergedBranches(repo.id, jobs, forge, db);
      await refreshOpenPrs(repo, jobs, forge, db);
    } catch (err) {
      logError(`[janitor] sweep failed for ${repo.name}`, err);
    }
  }
}
