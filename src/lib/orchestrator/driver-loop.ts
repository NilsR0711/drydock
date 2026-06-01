import { and, eq, inArray } from "drizzle-orm";
import { getAgentProvider } from "@/lib/agents/registry";
import { type DB, getDb } from "@/lib/db/client";
import { listRepos } from "@/lib/db/queries";
import { type Issue, issues, type Job, jobs, type Repo } from "@/lib/db/schema";
import type { CommandRunner } from "@/lib/exec/runner";
import { getForge } from "@/lib/forge/registry";
import type { ForgeClient } from "@/lib/forge/types";
import type { GhIssue } from "@/lib/github/gh";
import { withPriority } from "@/lib/github/priority";
import { RateLimitError } from "@/lib/github/rate-limit";
import { evaluateIssue } from "@/lib/issues/evaluator";
import { syncIssuesFromGh } from "@/lib/issues/service";
import { type TriageResult, triageRepo } from "@/lib/issues/triage";
import { logError } from "@/lib/log/logger";
import { type EdgeState, notifyCostLimitEdge } from "@/lib/notify/lifecycle";
import { authorAllowed, type RepoAutomation, repoAutomation } from "@/lib/repos/automation";
import { getSettings, jobsAllowed, repoJobsAllowed } from "@/lib/settings/service";
import { commandForAgent } from "./agent-command";
import { driveDeploymentHealing } from "./deployment-healing-driver";
import { listJobsByStatus } from "./jobs";
import {
  claimNext,
  DEFAULT_LEASE_MS,
  enqueueJob,
  HEARTBEAT_MS,
  heartbeat,
  releaseLease,
  requeueExpiredLeases,
  workerId,
} from "./queue";
import { driveReleaseManagement } from "./release-management-driver";
import { driveReviewFeedback } from "./review-feedback-driver";
import { runJob as defaultRunJob } from "./run-job";
import { activeJobCount, isDraining, registerActiveJob, unregisterActiveJob } from "./runtime";
import { buildSubtaskGenerator, decomposeRepo } from "./subtask-driver";

/** Latch so the daily cost-limit notification fires once per breach, not per tick. */
const costLimitState: EdgeState = { active: false };

export interface DriveTickDeps {
  db?: DB;
  fetchIssues?: (repoPath: string, label: string) => Promise<GhIssue[]>;
  runJob?: (jobId: number) => Promise<Job>;
  /** Forge client per repo (label/comment writes + default issue fetch). */
  forgeFor?: (repo: Repo) => ForgeClient;
  /** Auto-triage entry point (injectable for tests). */
  triage?: (repo: Repo, forge: ForgeClient, fetched: GhIssue[], db: DB) => Promise<TriageResult[]>;
  /** Decomposition sweep entry point (injectable for tests). */
  decompose?: (repo: Repo, forge: ForgeClient, candidates: GhIssue[], db: DB) => Promise<void>;
  /** Review-feedback sweep entry point (injectable for tests). */
  reviewFeedback?: (db: DB) => Promise<void>;
  /** Post-merge deployment-healing sweep entry point (injectable for tests). */
  deploymentHealing?: (db: DB) => Promise<void>;
  /** Post-merge release-management sweep entry point (injectable for tests). */
  releaseManagement?: (db: DB) => Promise<void>;
}

/**
 * Default decomposition step: split work-candidate issues into subtasks using
 * an agent one-shot fallback for prose, scoped to the repo's checkout. Bounded
 * to issues actually queued/ready for work by the caller.
 *
 * Routed through the repo's {@link getAgentProvider agent provider} (issue #49):
 * a Codex repo decomposes via `codex exec` with the configured `codexPath`, a
 * Claude repo via `claude -p` with `claudePath`, using the repo's own model —
 * never the global `claudePath` with Claude-shaped flags regardless of agent.
 */
export function defaultDecompose(
  repo: Repo,
  forge: ForgeClient,
  candidates: GhIssue[],
  db: DB,
  opts: { runner?: CommandRunner } = {},
): Promise<void> {
  const provider = getAgentProvider(repo.agent);
  const generate = buildSubtaskGenerator({
    provider,
    command: commandForAgent(provider, db),
    model: repo.defaultModel,
    cwd: repo.path,
    runner: opts.runner,
  });
  return decomposeRepo(repo, forge, candidates, db, { generate });
}

// A failed attempt is a job that ended parked for a human or aborted; merged
// jobs are successes and don't count toward maxAttempts.
const FAILED_ATTEMPT_STATES = ["needs_human", "aborted"] as const;

/** How many times automation has already tried (and failed) a given issue. */
function failedAttempts(db: DB, repoId: number, issueNumber: number): number {
  return db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.repoId, repoId),
        eq(jobs.issueNumber, issueNumber),
        inArray(jobs.status, [...FAILED_ATTEMPT_STATES]),
      ),
    )
    .all().length;
}

/** Move a priority-author issue to the front of the queue (lower = sooner). */
function boostPriority(db: DB, repoId: number, issueNumber: number): void {
  db.update(issues)
    .set({ priority: -1 })
    .where(and(eq(issues.repoId, repoId), eq(issues.number, issueNumber)))
    .run();
}

/**
 * Whether an auto-process repo may queue this issue: it carries a ready label,
 * no blocking label, and an approved author. On reaching maxAttempts the issue
 * is labelled needs-human and skipped rather than retried forever.
 */
async function autoEligible(
  repo: Repo,
  cfg: RepoAutomation,
  forge: ForgeClient,
  gh: GhIssue,
  labelNames: string[],
  db: DB,
): Promise<boolean> {
  const hasReady = labelNames.some((l) => cfg.readyLabels.includes(l));
  const hasBlocking = labelNames.some((l) => cfg.blockingLabels.includes(l));
  if (!hasReady || hasBlocking) return false;
  if (!authorAllowed(cfg, gh.authorAssociation)) return false;
  if (failedAttempts(db, repo.id, gh.number) >= cfg.maxAttempts) {
    if (!labelNames.includes(repo.needsHumanLabel)) {
      await forge.ensureLabel(repo.needsHumanLabel, {
        color: "d73a4a",
        description: "Drydock gave up after repeated failures; needs a human",
      });
      await forge.addLabels(gh.number, [repo.needsHumanLabel]);
    }
    return false;
  }
  return true;
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

/**
 * One scheduler tick: sync labelled issues into approved jobs, then start the
 * globally highest-priority queued jobs until the parallel budget or a gate is
 * hit. Per-repo and per-job failures are isolated so the loop keeps running.
 */
export async function driveTick(deps: DriveTickDeps = {}): Promise<void> {
  const db = deps.db ?? getDb();
  const runJob = deps.runJob ?? defaultRunJob;
  const repos = listRepos(db);

  const triage = deps.triage ?? triageRepo;
  const decompose = deps.decompose ?? defaultDecompose;
  for (const repo of repos) {
    // The background sweep runs at `low` priority so its GitHub calls yield the
    // rate-limit budget to interactive routes and active jobs (which run at the
    // default `high`). A gated sweep simply skips this repo until the budget
    // recovers — that is the intended back-pressure, not an error.
    try {
      await withPriority("low", async () => {
        const forge = deps.forgeFor?.(repo) ?? getForge(repo);
        // Default fetch refreshes the rate-limit budget (free probe) right
        // before listing; an injected fetcher owns its own metering.
        const fetch =
          deps.fetchIssues ??
          (async (_p: string, _label: string) => {
            await forge.refreshRateLimit?.();
            return forge.listAllIssues();
          });
        const fetched = await fetch(repo.path, repo.queueLabel);
        syncIssuesFromGh(repo.id, fetched, db);

        // Build a number→issue map so the enqueue step below can read
        // per-issue model/agent overrides without a query per issue.
        const cachedIssues = db.select().from(issues).where(eq(issues.repoId, repo.id)).all();
        const issueByNumber = new Map<number, Issue>(cachedIssues.map((i) => [i.number, i]));

        const cfg = repoAutomation(repo);
        if (cfg.autoTriageEnabled) {
          await triage(repo, forge, fetched, db);
        }

        // Opt-in decomposition (issue #19): split large work-candidate issues
        // into tracked subtasks before they are worked. Bounded to issues that
        // are queued or carry a ready label, to cap the per-issue detail fetch.
        if (cfg.autoDecompose) {
          const candidates = fetched.filter((gh) => {
            const labelNames = gh.labels.map((l) => l.name);
            return (
              labelNames.includes(repo.queueLabel) ||
              labelNames.some((l) => cfg.readyLabels.includes(l))
            );
          });
          if (candidates.length > 0) await decompose(repo, forge, candidates, db);
        }

        for (const gh of fetched) {
          const labelNames = gh.labels.map((l) => l.name);
          const manual = labelNames.includes(repo.queueLabel);
          const auto = cfg.autoProcessEnabled
            ? await autoEligible(repo, cfg, forge, gh, labelNames, db)
            : false;
          if (!manual && !auto) continue; // backlog issues aren't scheduled
          const verdict = evaluateIssue({ number: gh.number, title: gh.title, labels: labelNames });
          if (verdict.decision !== "approved") continue;
          if (hasOpenJob(db, repo.id, gh.number)) continue;
          if (auto && gh.author && cfg.priorityAuthors.includes(gh.author)) {
            boostPriority(db, repo.id, gh.number);
          }
          // Dedupe-guarded enqueue (issue #23): the partial unique index makes a
          // racing duplicate a no-op rather than a second job for the same issue.
          // Per-issue overrides (issue #101) take precedence over repo defaults.
          const issueMeta = issueByNumber.get(gh.number);
          enqueueJob(
            {
              repoId: repo.id,
              issueNumber: gh.number,
              model: issueMeta?.modelOverride ?? repo.defaultModel,
              agent: issueMeta?.agentOverride ?? repo.agent,
            },
            db,
          );
        }
      });
    } catch (err) {
      if (err instanceof RateLimitError) {
        console.debug(`[driver] ${repo.name} sweep yielded: ${err.message}`);
      } else {
        logError(`[driver] issue sync failed for ${repo.name}`, err);
      }
    }
  }

  // Edge-triggered cost-limit notification (issue #22): fire once when the
  // daily budget gate first closes, not on every poll tick.
  void notifyCostLimitEdge(jobsAllowed(db).reason === "cost_limit", costLimitState, db);

  // Reclaim leases that lapsed while the process was alive (e.g. a worker
  // whose heartbeat stopped without crashing the process). Startup recovery
  // uses requeueExpiredLeases({}) which requeues all working jobs; here we
  // only reclaim leases whose expiry has actually passed mid-run.
  requeueExpiredLeases({ expiredBefore: Math.floor(Date.now() / 1000) }, db);

  const max = getSettings(db).maxParallelJobs;
  const worker = workerId();
  while (!isDraining() && jobsAllowed(db).allowed && activeJobCount() < max) {
    // Repos eligible to start a job this turn: within their per-repo budget, and
    // — for sequential repos — without an in-flight job. A sequential repo's
    // just-claimed job is now "working" (in-flight), so it drops out next turn.
    const eligible = repos
      .filter((r) => repoJobsAllowed(r.id, db).allowed)
      .filter((r) => !(r.sequential && repoHasInFlightJob(db, r.id)))
      .map((r) => r.id);
    if (eligible.length === 0) break;

    // Atomically claim the globally highest-priority eligible job out of the
    // queue, stamping a lease. claimNext sets it to "working" (the working-state
    // guard in the agent session keeps spawning happy).
    const claimed = claimNext({ repoIds: eligible, worker, leaseMs: DEFAULT_LEASE_MS }, db);
    if (!claimed) break;
    const jobId = claimed.id;
    const leaseToken = claimed.leaseToken as string;
    registerActiveJob(jobId);

    // Keep the lease alive while the (long-running) job executes; release it once
    // the job settles so crash recovery never mistakes a finished job for orphaned.
    const beat = setInterval(() => {
      try {
        heartbeat(jobId, leaseToken, {}, db);
      } catch (err) {
        logError(`[driver] heartbeat failed for job ${jobId}`, err);
      }
    }, HEARTBEAT_MS);
    beat.unref?.();
    void runJob(jobId)
      .catch((err) => logError(`[driver] job ${jobId} failed`, err))
      .finally(() => {
        clearInterval(beat);
        releaseLease(jobId, leaseToken, db);
        unregisterActiveJob(jobId);
      });
  }

  // Drive the opt-in PR review-feedback lifecycle (issue #18) as a low-priority
  // background sweep, so its forge calls yield the rate-limit budget to active
  // jobs. Repos that have not opted in are skipped cheaply inside the sweep.
  const reviewFeedback = deps.reviewFeedback ?? ((d: DB) => driveReviewFeedback({ db: d }));
  try {
    await withPriority("low", () => reviewFeedback(db));
  } catch (err) {
    logError("[driver] review-feedback sweep failed", err);
  }

  // Drive opt-in post-merge deployment healing (issue #20) as another
  // low-priority background sweep. Repos that have not opted in (or that deploy
  // on no detectable platform) are skipped cheaply inside the sweep.
  const deploymentHealing =
    deps.deploymentHealing ?? ((d: DB) => driveDeploymentHealing({ db: d }));
  try {
    await withPriority("low", () => deploymentHealing(db));
  } catch (err) {
    logError("[driver] deployment-healing sweep failed", err);
  }

  // Drive opt-in release management (issue #59) as another low-priority
  // background sweep. The global kill-switch and per-repo opt-in are checked
  // cheaply inside the sweep, so a disabled feature costs almost nothing.
  const releaseManagement =
    deps.releaseManagement ?? ((d: DB) => driveReleaseManagement({ db: d }));
  try {
    await withPriority("low", () => releaseManagement(db));
  } catch (err) {
    logError("[driver] release-management sweep failed", err);
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
        logError("[driver] tick failed", err);
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
