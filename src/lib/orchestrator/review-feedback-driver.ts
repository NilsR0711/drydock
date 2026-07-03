import { getAgentProvider } from "@/lib/agents/registry";
import type { AgentId } from "@/lib/agents/types";
import { type DB, getDb } from "@/lib/db/client";
import { listRepos } from "@/lib/db/queries";
import type { Job, Repo } from "@/lib/db/schema";
import { getForge } from "@/lib/forge/registry";
import type { ForgeClient, ReviewThread } from "@/lib/forge/types";
import { type Worktree, WorktreeManager } from "@/lib/git/worktree";
import { withPriority } from "@/lib/github/priority";
import { logError } from "@/lib/log/logger";
import { repoAutomation } from "@/lib/repos/automation";
import { getSettings } from "@/lib/settings/service";
import { globalSingleton } from "@/lib/util/global-singleton";
import { commandForAgent } from "./agent-command";
import { spawnAgentSession } from "./agent-session";
import { listJobs } from "./jobs";
import { agentLimitBlocked } from "./provider-limit";
import { type FeedbackApplyResult, processPrFeedback, type ReviewForge } from "./review-feedback";

/**
 * Background sweep that drives the PR review-feedback lifecycle (issue #18) for
 * every repo that has opted in. It is intentionally separate from the issue
 * scheduler: feedback arrives after a PR is open, so it iterates jobs that have
 * reached a PR rather than the issue queue. Per-repo and per-job failures are
 * isolated so one bad PR never stalls the sweep.
 */

/** Job states in which a PR is plausibly still open for review. */
const PR_OPEN_STATES = new Set(["ci_running", "ci_failed", "retrying", "needs_human"]);

/** Whether a forge implements the optional review-thread surface (GitHub does). */
function supportsReviewThreads(forge: ForgeClient): forge is ForgeClient & ReviewForge {
  return (
    typeof forge.listReviewThreads === "function" &&
    typeof forge.replyToReviewThread === "function" &&
    typeof forge.updateReviewComment === "function" &&
    typeof forge.resolveReviewThread === "function" &&
    typeof forge.reactToReviewComment === "function"
  );
}

export interface DriveFeedbackDeps {
  db?: DB;
  forgeFor?: (repo: Repo) => ForgeClient;
  /** Process one job's PR feedback (injectable for tests). */
  processJob?: (repo: Repo, job: Job, forge: ForgeClient) => Promise<void>;
  /** Limit the sweep to one repo (webhook-triggered sweeps, issue #180). */
  repoId?: number;
}

export async function driveReviewFeedback(deps: DriveFeedbackDeps = {}): Promise<void> {
  const db = deps.db ?? getDb();
  const processJob = deps.processJob ?? defaultProcessJob;

  for (const repo of listRepos(db)) {
    if (deps.repoId != null && repo.id !== deps.repoId) continue;
    if (!repoAutomation(repo).autoReviewFeedback) continue;
    try {
      const forge = deps.forgeFor?.(repo) ?? getForge(repo);
      if (!supportsReviewThreads(forge)) continue;

      // Jobs whose agent is limit-latched are skipped (issue #167): their side
      // sessions would only bounce off the pre-spawn guard and burn the item's
      // fix-attempt budget; the next sweep picks them up once the latch clears.
      const candidates = listJobs(repo.id, db).filter(
        (j) =>
          j.prNumber != null &&
          PR_OPEN_STATES.has(j.status) &&
          !agentLimitBlocked(j.agent as AgentId, db),
      );
      for (const job of candidates) {
        try {
          await processJob(repo, job, forge);
        } catch (err) {
          logError(`[review-feedback] job ${job.id} failed for ${repo.name}`, err);
        }
      }
    } catch (err) {
      logError(`[review-feedback] sweep failed for ${repo.name}`, err);
    }
  }
}

/** Build the prompt that asks the agent to address a single review comment. */
function feedbackPrompt(thread: ReviewThread): string {
  const first = thread.comments[0];
  const where = thread.path ? `${thread.path}${thread.line ? `:${thread.line}` : ""}` : "this PR";
  return [
    `A reviewer left this comment on ${where} of the current pull request:`,
    "",
    (first?.body ?? "").trim(),
    "",
    "Make only the change this comment asks for. Do not address anything else.",
    "When done, ensure the working tree builds and tests pass, then stop — the",
    "commit and push are handled for you.",
  ].join("\n");
}

/** The worktree operations the agent-apply step needs (injectable for tests). */
export interface FeedbackWorktrees {
  prepareForBranch(repo: Repo, branch: string, key: string): Promise<Worktree>;
  commitAndPush(wt: Worktree, message: string): Promise<void>;
  remove(wt: Worktree, repoPath: string): Promise<void>;
}

export interface AgentApplyDeps {
  repo: Repo;
  job: Job;
  worktrees: FeedbackWorktrees;
  runSession: (job: Job, prompt: string, cwd: string) => Promise<{ exitCode: number }>;
}

/**
 * Build the `applyFeedback` callback for one job: it checks out the PR branch in
 * an isolated worktree, runs the agent against the single review comment,
 * commits and pushes, and tears the worktree down. A non-zero agent exit or an
 * empty commit (nothing staged) reports failure so the lifecycle can retry or
 * flag for a human. Never merges the PR.
 */
export function buildAgentApply(
  deps: AgentApplyDeps,
): (item: unknown, thread: ReviewThread) => Promise<FeedbackApplyResult> {
  return async (_item, thread) => {
    if (!deps.job.branch) return { ok: false, detail: "job has no branch" };
    const wt = await deps.worktrees.prepareForBranch(
      deps.repo,
      deps.job.branch,
      `${deps.job.id}-${thread.id}`,
    );
    try {
      const session = await deps.runSession(deps.job, feedbackPrompt(thread), wt.path);
      if (session.exitCode !== 0) return { ok: false, detail: "agent exited non-zero" };
      try {
        await deps.worktrees.commitAndPush(wt, `Address review feedback on ${thread.path ?? "PR"}`);
      } catch {
        return { ok: false, detail: "no change produced" };
      }
      return { ok: true };
    } finally {
      try {
        await deps.worktrees.remove(wt, deps.repo.path);
      } catch (err) {
        logError(`[review-feedback] worktree cleanup failed for job ${deps.job.id}`, err);
      }
    }
  };
}

/**
 * Run a sweep serialized against every other sweep (issue #180): the cadence
 * sweep in the driver loop and webhook-triggered sweeps share one promise
 * chain, so two sweeps can never process the same PR's feedback concurrently
 * (which would double-spawn agent side sessions for the same thread, and race a
 * stale `failed` transition against a successful `resolved` — issue #326). A
 * rejection propagates to its own caller but never breaks the chain.
 *
 * The chain lives on `globalThis`, not in a module-local closure, for the same
 * reason as the orchestrator's abort registry (issue #232): Next.js compiles
 * the background orchestrator, Route Handlers, and Server Actions into separate
 * bundle layers that each evaluate this module independently. The cadence sweep
 * runs in the orchestrator layer; webhook-triggered sweeps run in a route layer.
 * A module-local chain would give each layer its own, so the two sweeps would
 * overlap on the same PR's threads — exactly the race in #326. A process-global
 * chain is shared across every layer, restoring mutual exclusion.
 */
const SWEEP_CHAIN_KEY = Symbol.for("drydock.review-feedback.sweep-chain");
type GlobalWithChain = typeof globalThis & { [SWEEP_CHAIN_KEY]?: Promise<void> };
const globalWithChain = globalThis as GlobalWithChain;
globalWithChain[SWEEP_CHAIN_KEY] ??= Promise.resolve();

export function runReviewFeedbackSweep(deps: DriveFeedbackDeps = {}): Promise<void> {
  // Read and write the chain through globalThis on every call so two module
  // instances (distinct bundle layers) extend the same chain rather than each
  // their own — a module-local cache would defeat the cross-layer sharing.
  const chain = globalWithChain[SWEEP_CHAIN_KEY] ?? Promise.resolve();
  const run = chain.then(() => driveReviewFeedback(deps));
  globalWithChain[SWEEP_CHAIN_KEY] = run.catch(() => {});
  return run;
}

/** How long to wait after the last review delivery before sweeping, so a bot
 * review burst (one review + many comments) coalesces into one sweep. */
export const REVIEW_SWEEP_DEBOUNCE_MS = 2_000;

type SweepRunner = (repoId: number) => Promise<void>;

// Low priority mirrors the cadence sweep in the driver loop: feedback forge
// calls always yield the rate-limit budget to active jobs.
const defaultSweepRunner: SweepRunner = (repoId) =>
  withPriority("low", () => runReviewFeedbackSweep({ repoId }));

let sweepRunner: SweepRunner = defaultSweepRunner;

// The debounce registry lives on `globalThis`, matching the sweep chain above:
// the cadence sweep debounces in the driver-loop layer while webhook-triggered
// sweeps debounce in a Route Handler layer, and a module-local Map would let a
// driver-tick sweep and a webhook sweep for the same repo schedule separately
// instead of coalescing (issue #379). setTimeout/clearTimeout handles are
// process-wide, so any layer can cancel a timer another layer scheduled.
const PENDING_SWEEPS_KEY = Symbol.for("drydock.review-feedback.pending-sweeps");
const pendingSweeps = globalSingleton(
  PENDING_SWEEPS_KEY,
  () => new Map<number, ReturnType<typeof setTimeout>>(),
);

/**
 * Schedule a debounced, repo-targeted sweep after a verified review webhook
 * delivery (issue #180), so new feedback is picked up within seconds instead
 * of at the next driver tick. Repeated triggers within the window collapse
 * into one run; distinct repos are independent. Failures are isolated and
 * logged so a broken sweep never throws into the receiver's request path.
 */
export function triggerReviewFeedbackSweep(
  repoId: number,
  delayMs = REVIEW_SWEEP_DEBOUNCE_MS,
): void {
  const existing = pendingSweeps.get(repoId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    pendingSweeps.delete(repoId);
    void sweepRunner(repoId).catch((err) => {
      logError(`[webhook] review-feedback sweep failed for repo ${repoId}`, err);
    });
  }, delayMs);
  // A pending sweep must not keep the Node process alive on its own.
  (timer as { unref?: () => void }).unref?.();
  pendingSweeps.set(repoId, timer);
}

/** Test seam: override (or, with `null`, reset) the triggered-sweep runner. */
export function __setReviewSweepRunner(override: SweepRunner | null): void {
  sweepRunner = override ?? defaultSweepRunner;
}

/** Test helper: number of repos with a triggered sweep currently pending. */
export function __pendingReviewSweepCount(): number {
  return pendingSweeps.size;
}

/** Production composition: real forge, worktree, and agent session. */
async function defaultProcessJob(repo: Repo, job: Job, forge: ForgeClient): Promise<void> {
  if (!supportsReviewThreads(forge) || job.prNumber == null) return;
  const db = getDb();
  const cfg = repoAutomation(repo);
  const provider = getAgentProvider(job.agent);
  const command = commandForAgent(provider, db);
  const worktrees = new WorktreeManager();
  // Bound the side session exactly like the main job run (issue #383): a per-repo
  // override wins, else the global default. Without these a hung feedback-fix CLI
  // is awaited forever (agent-session short-circuits to a bare `handle.done` when
  // neither bound is set), which freezes the whole driver tick and never frees
  // the slot — the tick only reschedules after this sweep returns.
  const settings = getSettings(db);
  const timeoutMs = (repo.maxJobMinutes ?? settings.maxJobMinutes) * 60_000;
  const costCapUsd = repo.maxJobCostUsd ?? settings.maxJobCostUsd;

  const applyFeedback = buildAgentApply({
    repo,
    job,
    worktrees,
    // sideSession: the job already sits in a PR-open state (ci_running, …);
    // a normal spawn would force an invalid `working` transition and throw
    // before the agent ever starts.
    runSession: (j, prompt, cwd) =>
      spawnAgentSession(j, prompt, cwd, {
        db,
        provider,
        command,
        sideSession: true,
        timeoutMs,
        costCapUsd,
        // Native-build repos (#283) opt out of the sandbox via this flag; without
        // it the side session falls back to acceptEdits and bash/xcodebuild/simctl
        // are blocked, so review feedback that needs a real build silently fails
        // and burns its retry budget (#328). The normal and release job paths
        // already forward it — this side-session path must too.
        bypassPermissions: repo.bypassPermissions,
        // Likewise carry the per-repo command allowlist (issue #329): a native-build
        // repo whose feedback fix re-runs xcodebuild/git needs those commands
        // pre-approved here too, not just on the main implement path. Inert when
        // bypassPermissions is on (full access already covers them). Empty by default.
        allowedCommands: cfg.allowedCommands,
      }).then((r) => ({
        exitCode: r.exitCode,
      })),
  });

  await processPrFeedback(job.id, job.prNumber, {
    forge,
    db,
    gate: {
      trustedReviewers: cfg.trustedReviewers,
      trustedBots: cfg.trustedBots,
      ignoredBots: cfg.ignoredBots,
    },
    includeProgressReplies: cfg.includeProgressReplies,
    applyFeedback,
  });
}
