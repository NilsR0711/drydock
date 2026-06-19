import { and, eq } from "drizzle-orm";
import { getAgentProvider } from "@/lib/agents/registry";
import { type DB, getDb } from "@/lib/db/client";
import { listRepos } from "@/lib/db/queries";
import { type Job, jobEvents, jobs as jobsTable, type Repo } from "@/lib/db/schema";
import { upsertMarkerComment } from "@/lib/forge/comment-upsert";
import { getForge } from "@/lib/forge/registry";
import type { ForgeClient, PrMergeState } from "@/lib/forge/types";
import { WorktreeManager } from "@/lib/git/worktree";
import { logError } from "@/lib/log/logger";
import { commandForAgent } from "./agent-command";
import { spawnAgentSession } from "./agent-session";
import { getJob, listJobs, recordEvent, transitionJob } from "./jobs";
import { markIssueNeedsHuman } from "./needs-human";
import { repairMergeConflicts } from "./review-feedback";
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

/**
 * Rebase a conflicted PR branch onto its base and force-push, reporting whether
 * the rebase cleared the conflict (issue #287). Injectable so the sweep is
 * testable without real git; defaults to {@link defaultRebaseBranch}.
 */
export type RebaseBranch = (
  repo: Repo,
  branch: string,
  prNumber: number,
) => Promise<{ ok: boolean }>;

/**
 * Resolve a conflicted PR branch by rebasing it onto its base and handing the
 * genuine content conflicts to an agent, force-pushing the result (issue #327).
 * Injectable so the sweep stays testable without spawning a real agent;
 * defaults to {@link defaultAgentResolveBranch}. `resolvedConflicts` is the
 * number of conflict stops the agent cleared, for the audit trail.
 */
export type AgentResolveBranch = (
  repo: Repo,
  job: Job,
  prNumber: number,
) => Promise<{ ok: boolean; resolvedConflicts: number }>;

export interface JanitorDeps {
  db?: DB;
  forgeFor?: (repo: Repo) => ForgeClient;
  rebaseBranch?: RebaseBranch;
  agentResolveBranch?: AgentResolveBranch;
}

/**
 * Upper bound on rebase attempts per conflicted PR (issue #287). One is the
 * right budget: a rebase onto the same base is deterministic, so a second try
 * would only repeat the first's outcome. The bound is expressed through the
 * shared {@link repairMergeConflicts} helper to keep the repair budgeted and
 * consistent with the review-feedback path.
 */
const REBASE_MAX_ATTEMPTS = 1;

/**
 * Production rebase: check out the PR branch in an isolated worktree, rebase it
 * onto the repo's default branch (force-pushing only what the rebase rewrites),
 * and tear the worktree down. Cleanup failures are logged, never thrown — the
 * rebase outcome is what the caller acts on.
 */
async function defaultRebaseBranch(
  repo: Repo,
  branch: string,
  prNumber: number,
): Promise<{ ok: boolean }> {
  const worktrees = new WorktreeManager();
  const wt = await worktrees.prepareForBranch(repo, branch, `janitor-pr-${prNumber}`);
  try {
    return await worktrees.rebaseOntoBase(wt, repo.defaultBranch, repo.path);
  } finally {
    try {
      await worktrees.remove(wt, repo.path);
    } catch (err) {
      logError(`[janitor] worktree cleanup failed after rebase of PR #${prNumber}`, err);
    }
  }
}

/**
 * Build the focused prompt handed to the agent at each conflict stop (issue
 * #327). It names the base, lists the conflicted files, and constrains the
 * agent to resolving the markers only — staging and `rebase --continue` are
 * performed by the worktree primitive, so the agent must not run git itself.
 */
function conflictResolutionPrompt(baseBranch: string, conflicts: string[]): string {
  return [
    `This branch is being rebased onto \`${baseBranch}\` and git has stopped on merge`,
    "conflicts in the following file(s):",
    "",
    ...conflicts.map((path) => `- ${path}`),
    "",
    "Resolve every conflict marker (<<<<<<<, =======, >>>>>>>) in those files,",
    "preserving the intent of BOTH sides of each conflict. Do not change any code",
    "unrelated to the conflicts. Do not run git — staging the resolved files and",
    "continuing the rebase are handled for you. When no conflict markers remain,",
    "stop.",
  ].join("\n");
}

/**
 * Production agent-assisted conflict resolution (issue #327): check the PR
 * branch out in an isolated worktree and rebase it onto the default branch,
 * spawning a bounded side-session agent at each conflict stop to resolve the
 * markers in place. The agent runs with the repo's `bypassPermissions` setting,
 * as a `sideSession` so the open PR's job state is left untouched. A non-zero
 * agent exit aborts the rebase (reported as `{ ok: false }`), and the worktree
 * is always torn down. Never merges; only rebase + force-push-with-lease.
 */
async function defaultAgentResolveBranch(
  repo: Repo,
  job: Job,
  prNumber: number,
): Promise<{ ok: boolean; resolvedConflicts: number }> {
  const branch = job.branch as string;
  const db = getDb();
  const provider = getAgentProvider(job.agent);
  const command = commandForAgent(provider, db);
  const worktrees = new WorktreeManager();
  const wt = await worktrees.prepareForBranch(repo, branch, `janitor-conflict-pr-${prNumber}`);
  try {
    return await worktrees.rebaseOntoBaseWithResolver(
      wt,
      repo.defaultBranch,
      repo.path,
      async (conflicts) => {
        const result = await spawnAgentSession(
          job,
          conflictResolutionPrompt(repo.defaultBranch, conflicts),
          wt.path,
          { db, provider, command, sideSession: true, bypassPermissions: repo.bypassPermissions },
        );
        // A non-zero exit means the agent did not finish; throw so the primitive
        // aborts the rebase and the caller falls back to escalation.
        if (result.exitCode !== 0) throw new Error("conflict-resolution agent exited non-zero");
      },
    );
  } finally {
    try {
      await worktrees.remove(wt, repo.path);
    } catch (err) {
      logError(`[janitor] worktree cleanup failed after agent resolve of PR #${prNumber}`, err);
    }
  }
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
 * conflicted PR is auto-rebased when the repo opts in (issue #287) and only
 * escalated to `needs_human` if the rebase cannot clear it. Clean and
 * not-yet-computed states are left alone.
 */
async function refreshOpenPrs(
  repo: Repo,
  jobs: Job[],
  forge: ForgeClient,
  db: DB,
  rebaseBranch: RebaseBranch,
  agentResolveBranch: AgentResolveBranch,
): Promise<void> {
  const probe = forge.prMergeState;
  if (typeof probe !== "function") return;
  const candidates = jobs.filter(
    (j) => REFRESH_STATES.has(j.status) && j.prNumber !== null && isDrydockBranch(j.branch),
  );
  for (const job of candidates) {
    const prNumber = job.prNumber as number;
    try {
      const state = await probe.call(forge, prNumber);
      if (state === "behind" && typeof forge.updatePrBranch === "function") {
        await forge.updatePrBranch(prNumber);
        recordEvent(job.id, JANITOR_EVENT, { action: "branch_updated", prNumber }, db);
      } else if (state === "conflicted") {
        await handleConflict(repo, job, prNumber, forge, db, rebaseBranch, agentResolveBranch);
      }
    } catch (err) {
      logError(`[janitor] PR refresh failed for job ${job.id} (PR #${prNumber})`, err);
    }
  }
}

/**
 * Hidden marker keyed by job id so re-escalating the same job (it was requeued
 * and conflicts again) edits the same comment in place instead of stacking a
 * fresh one (idempotency, ADR 019; issue #289).
 */
export function conflictCommentMarker(jobId: number): string {
  return `<!-- drydock:conflict:${jobId} -->`;
}

/**
 * Hidden marker for the auditable comment posted on a PR whose conflicts an
 * agent resolved (issue #327), keyed by job id so a re-resolution edits the
 * same comment in place (ADR 019 idempotency).
 */
export function agentResolveCommentMarker(jobId: number): string {
  return `<!-- drydock:agent-conflict-resolve:${jobId} -->`;
}

/**
 * Decide a conflicted PR's fate. First, when the repo enables
 * `autoResolveMergeConflicts`, attempt the bounded plain rebase and let a
 * cleared PR proceed — this handles a branch that is merely behind or has only
 * trivial conflicts (issue #287). Failing that, when the repo opts into
 * `resolveConflictsWithAgent`, hand the genuine content conflicts to an agent
 * before giving up (issue #327). Only when both paths are off or fail do we
 * park for a human. The two flags are independent: agent resolution is attempted
 * even with the plain-rebase flag off. The candidate filter guarantees a
 * Drydock-owned branch.
 */
async function handleConflict(
  repo: Repo,
  job: Job,
  prNumber: number,
  forge: ForgeClient,
  db: DB,
  rebaseBranch: RebaseBranch,
  agentResolveBranch: AgentResolveBranch,
): Promise<void> {
  if (
    repo.autoResolveMergeConflicts &&
    (await attemptAutoRebase(repo, job, prNumber, forge, db, rebaseBranch))
  ) {
    return;
  }
  if (
    repo.resolveConflictsWithAgent &&
    (await attemptAgentResolve(repo, job, prNumber, forge, db, agentResolveBranch))
  ) {
    return;
  }
  await escalateConflict(repo, job, prNumber, forge, db);
}

/**
 * Hand a genuine content conflict to an agent (issue #327): rebase the branch
 * with agent-resolved markers, and on success stamp a janitor event and post an
 * auditable comment on the PR so a human can review what was resolved. Any
 * failure — the agent cannot clear it, or the resolve throws — is logged and
 * reported as unresolved so the caller parks for a human (the safe default).
 * Returns whether the conflict was resolved.
 */
async function attemptAgentResolve(
  repo: Repo,
  job: Job,
  prNumber: number,
  forge: ForgeClient,
  db: DB,
  agentResolveBranch: AgentResolveBranch,
): Promise<boolean> {
  try {
    const { ok, resolvedConflicts } = await agentResolveBranch(repo, job, prNumber);
    if (!ok) return false;
    recordEvent(
      job.id,
      JANITOR_EVENT,
      { action: "agent_resolved", prNumber, resolvedConflicts },
      db,
    );
    await postAgentResolveComment(job, prNumber, resolvedConflicts, forge);
    return true;
  } catch (err) {
    logError(`[janitor] agent conflict resolution failed for job ${job.id} (PR #${prNumber})`, err);
    return false;
  }
}

/** Post the auditable "an agent resolved these conflicts" comment on the PR
 * itself (issue #327). Best-effort: a failed comment never undoes the resolved
 * rebase, so the PR proceeds regardless. */
async function postAgentResolveComment(
  job: Job,
  prNumber: number,
  resolvedConflicts: number,
  forge: ForgeClient,
): Promise<void> {
  try {
    const marker = agentResolveCommentMarker(job.id);
    const noun = resolvedConflicts === 1 ? "conflict" : "conflicts";
    const body =
      `${marker}\n\n🤝 Drydock automatically resolved ${resolvedConflicts} merge ${noun} on this ` +
      "PR by rebasing onto the base branch with an agent, then force-pushed the result. " +
      "Please review the rebased diff before merging.";
    await upsertMarkerComment(forge, prNumber, marker, body, "janitor");
  } catch (err) {
    logError(`[janitor] agent-resolve comment failed for job ${job.id} (PR #${prNumber})`, err);
  }
}

/**
 * Run the shared, bounded merge-conflict repair on a conflicted PR (issue #287):
 * rebase the branch onto its base and treat a clean rebase as authoritative —
 * a successful local rebase guarantees the branch now applies on the base, so
 * the forge's (eventually consistent) merge state is only consulted to short-
 * circuit a conflict that already cleared on its own. A cleared PR is stamped
 * with a janitor event and left in place for the merge gate. Any failure is
 * logged and reported as unresolved so the caller parks for a human — the safe
 * default. Returns whether the conflict was resolved.
 */
async function attemptAutoRebase(
  repo: Repo,
  job: Job,
  prNumber: number,
  forge: ForgeClient,
  db: DB,
  rebaseBranch: RebaseBranch,
): Promise<boolean> {
  const branch = job.branch as string;
  // The only caller (`refreshOpenPrs`) reached `conflicted` via this probe, so
  // it is guaranteed present here.
  const probe = forge.prMergeState as (n: number) => Promise<PrMergeState>;
  try {
    // A clean rebase is the source of truth: once `rebase` succeeds we report no
    // conflicts directly rather than re-polling the forge, which may still serve
    // a stale `conflicted` (or `unknown`) for a moment after the force-push.
    let clearedByRebase = false;
    const result = await repairMergeConflicts({
      maxAttempts: REBASE_MAX_ATTEMPTS,
      hasConflicts: async () => {
        if (clearedByRebase) return false;
        return (await probe.call(forge, prNumber)) === "conflicted";
      },
      rebase: async () => {
        const outcome = await rebaseBranch(repo, branch, prNumber);
        clearedByRebase = outcome.ok;
        return outcome;
      },
    });
    if (result.resolved) {
      recordEvent(
        job.id,
        JANITOR_EVENT,
        { action: "rebased", prNumber, attempts: result.attempts },
        db,
      );
      return true;
    }
    return false;
  } catch (err) {
    logError(`[janitor] auto-rebase failed for job ${job.id} (PR #${prNumber})`, err);
    return false;
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
    const marker = conflictCommentMarker(job.id);
    const body =
      `${marker}\n\n⚠️ PR #${prNumber} conflicts with \`${repo.defaultBranch}\` — a rebase is needed. ` +
      `Parking job #${job.id} for a human.`;
    await upsertMarkerComment(forge, job.issueNumber, marker, body, "janitor");
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
  const rebaseBranch = deps.rebaseBranch ?? defaultRebaseBranch;
  const agentResolveBranch = deps.agentResolveBranch ?? defaultAgentResolveBranch;
  for (const repo of listRepos(db)) {
    try {
      const forge = deps.forgeFor?.(repo) ?? getForge(repo);
      const jobs = listJobs(repo.id, db);
      await cleanupMergedBranches(repo.id, jobs, forge, db);
      await refreshOpenPrs(repo, jobs, forge, db, rebaseBranch, agentResolveBranch);
    } catch (err) {
      logError(`[janitor] sweep failed for ${repo.name}`, err);
    }
  }
}
