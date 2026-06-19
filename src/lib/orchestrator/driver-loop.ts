import { and, eq, inArray } from "drizzle-orm";
import { AGENT_IDS, getAgentProvider } from "@/lib/agents/registry";
import type { AgentId } from "@/lib/agents/types";
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
import {
  type EdgeState,
  notifyCostLimitEdge,
  notifyCredentialEdge,
  notifyProviderLimitEdge,
} from "@/lib/notify/lifecycle";
import { shouldSyncCatalog, syncOpenRouterCatalog } from "@/lib/openrouter/catalog";
import { resolveOpenRouterApiKey } from "@/lib/openrouter/config";
import { authorAllowed, type RepoAutomation, repoAutomation } from "@/lib/repos/automation";
import { getSettings, jobsAllowed, repoJobsAllowed } from "@/lib/settings/service";
import { commandForAgent } from "./agent-command";
import { runBranchJanitorSweep } from "./branch-janitor";
import { getCredentialFailures } from "./credential-status";
import { runCredentialProbeSweep, shouldRunCredentialProbe } from "./credential-watchdog";
import { driveDeploymentHealing } from "./deployment-healing-driver";
import { listJobsByStatus, recordEvent, transitionJob } from "./jobs";
import { agentLimitBlocked } from "./provider-limit";
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
import { runReviewFeedbackSweep } from "./review-feedback-driver";
import { runJob as defaultRunJob } from "./run-job";
import { activeJobCount, isDraining, registerActiveJob, unregisterActiveJob } from "./runtime";
import { reconcileExternalAborts } from "./singleton";
import { JOB_STATES, TERMINAL_STATES } from "./state-machine";
import { buildSubtaskGenerator, decomposeRepo } from "./subtask-driver";
import { driveTrackedPrs } from "./tracked-pr-driver";

/** Latch so the daily cost-limit notification fires once per breach, not per tick. */
const costLimitState: EdgeState = { active: false };
/** Latch so the credential-watchdog notification fires once per outage (issue #177). */
const credentialEdgeState: EdgeState = { active: false };
/** Latches so the per-agent limit enter/exit notifications fire once per edge (issues #166/#167). */
const providerLimitStates: Record<AgentId, EdgeState> = {
  claude: { active: false },
  codex: { active: false },
  openrouter: { active: false },
};

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
  /** Branch & PR janitor sweep entry point (issue #181, injectable for tests). */
  branchJanitor?: (db: DB) => Promise<void>;
  /** URL-tracked PR babysitting sweep entry point (issue #293, injectable for tests). */
  trackedPrs?: (db: DB) => Promise<void>;
  /** OpenRouter catalog sync entry point (issue #169, injectable for tests). */
  openrouterCatalogSync?: (db: DB) => Promise<unknown>;
  /** Credential watchdog probe round (issue #177, injectable for tests). */
  credentialProbe?: (db: DB) => Promise<unknown>;
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
    db,
    runner: opts.runner,
  });
  return decomposeRepo(repo, forge, candidates, db, { generate });
}

/** Shared GitHub-label metadata for the repo's needs-human escalation label. */
const NEEDS_HUMAN_LABEL_DEF = {
  color: "d73a4a",
  description: "Drydock needs a human before automating this issue",
} as const;

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
      await forge.ensureLabel(repo.needsHumanLabel, NEEDS_HUMAN_LABEL_DEF);
      await forge.addLabels(gh.number, [repo.needsHumanLabel]);
    }
    return false;
  }
  return true;
}

/**
 * Surface an auto-eligible issue that the review heuristic downgraded to
 * `needs_review` (issue #240). That decision used to be a dead end — computed
 * but never routed — so the issue was silently dropped on every tick with no
 * label, comment, or UI feedback. Route it to the repo's needs-human label with
 * the reasons as a comment, mirroring the maxAttempts escalation in
 * {@link autoEligible}. Idempotent: once the label is present (re-read from the
 * forge on the next tick) the routing is skipped, so the comment fires once.
 */
async function routeNeedsReview(
  repo: Repo,
  forge: ForgeClient,
  gh: GhIssue,
  labelNames: string[],
  reasons: string[],
): Promise<void> {
  if (labelNames.includes(repo.needsHumanLabel)) return;
  await forge.ensureLabel(repo.needsHumanLabel, NEEDS_HUMAN_LABEL_DEF);
  await forge.addLabels(gh.number, [repo.needsHumanLabel]);
  const why = reasons.length > 0 ? reasons.join("; ") : "flagged for human review";
  await forge.commentIssue(
    gh.number,
    `⏸️ Held for human review before automated work — ${why}. ` +
      `Remove the \`${repo.needsHumanLabel}\` label or use "Start now" to proceed.`,
  );
}

// Every non-terminal state counts as "open" for issue-level dedupe, including
// the operator-gated parking states (needs_human/interrupted, ADR 005): a
// parked issue is skipped by the tick instead of churning a no-op enqueue (or,
// worse, auto-requeueing past the operator gate) every poll. Derived from the
// state machine so it stays in lockstep with enqueueJob's non-terminal dedupe.
const OPEN_STATES = JOB_STATES.filter((s) => !TERMINAL_STATES.includes(s));
// Non-terminal, already-started states. A repo with any such job is "in flight":
// for sequential repos the next issue waits until this clears. Parked jobs
// (needs_human/interrupted) are deliberately NOT in flight — they must not
// block a sequential repo's pipeline while they wait on an operator. A
// limit-parked job (waiting_limit, issue #166) IS in flight: it resumes on its
// own, mid-implementation, so a sequential repo must not start the next issue
// around it.
const IN_FLIGHT_STATES = [
  "working",
  "ci_running",
  "ci_failed",
  "retrying",
  "waiting_limit",
] as const;

function hasOpenJob(db: DB, repoId: number, issueNumber: number): boolean {
  return listJobsByStatus([...OPEN_STATES], db).some(
    (j) => j.repoId === repoId && j.issueNumber === issueNumber,
  );
}

function repoHasInFlightJob(db: DB, repoId: number): boolean {
  return listJobsByStatus([...IN_FLIGHT_STATES], db).some((j) => j.repoId === repoId);
}

/**
 * Requeue jobs parked on `agent`'s usage limit once its latch has cleared
 * (issues #166/#167). The limitKind marker survives the requeue so run-job
 * resumes the stored session; the breadcrumb comment on the issue is
 * best-effort. Called only while that agent's latch is not blocking, so this
 * tick's claim loop can pick the jobs straight back up.
 */
async function resumeLimitParkedJobs(
  agent: AgentId,
  repos: Repo[],
  deps: DriveTickDeps,
  db: DB,
): Promise<void> {
  const label =
    agent === "codex"
      ? "Codex capacity"
      : agent === "openrouter"
        ? "OpenRouter window"
        : "Claude quota";
  const parked = listJobsByStatus(["waiting_limit"], db).filter((j) => j.agent === agent);
  for (const job of parked) {
    try {
      transitionJob(job.id, "queued", { availableAt: null, errorMessage: null }, db);
      recordEvent(job.id, "status", { reason: `${agent}_limit_cleared` }, db);
    } catch (err) {
      // A concurrent operator action (abort, manual requeue) settled the job
      // between the list and the transition; skip it.
      logError(`[driver] limit requeue failed for job ${job.id}`, err);
      continue;
    }
    const repo = repos.find((r) => r.id === job.repoId);
    if (!repo) continue;
    try {
      const forge = deps.forgeFor?.(repo) ?? getForge(repo);
      await forge.commentIssue(
        job.issueNumber,
        `▶️ ${label} available again — resuming job #${job.id}.`,
      );
    } catch (err) {
      logError(`[driver] limit-resume comment failed for job ${job.id}`, err);
    }
  }
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
        // Skipped while the repo's agent is limit-latched (issue #167): every
        // one-shot would only bounce off the exhausted quota, and a limit
        // failure mid-sweep must not stamp issues as non-decomposable.
        if (cfg.autoDecompose && !agentLimitBlocked(repo.agent as AgentId, db)) {
          const candidates = fetched.filter((gh) => {
            const labelNames = gh.labels.map((l) => l.name);
            return (
              labelNames.includes(repo.queueLabel) ||
              labelNames.some((l) => cfg.readyLabels.includes(l))
            );
          });
          if (candidates.length > 0) {
            try {
              await decompose(repo, forge, candidates, db);
            } catch (err) {
              // A provider-limit abort latched the agent and stopped the sweep
              // (issue #167); issue enqueueing below must still run — claimNext
              // excludes the latched agent's jobs anyway.
              logError(`[driver] decomposition sweep failed for ${repo.name}`, err);
            }
          }
        }

        for (const gh of fetched) {
          const labelNames = gh.labels.map((l) => l.name);
          const manual = labelNames.includes(repo.queueLabel);
          const auto = cfg.autoProcessEnabled
            ? await autoEligible(repo, cfg, forge, gh, labelNames, db)
            : false;
          if (!manual && !auto) continue; // backlog issues aren't scheduled
          const verdict = evaluateIssue({ number: gh.number, title: gh.title, labels: labelNames });
          // A blocking label is an explicit, already-visible signal — skip on
          // either path (the label itself is the feedback).
          if (verdict.decision === "blocked") continue;
          // The `needs_review` heuristic gates the AUTO path only. A human who
          // manually queued an issue has expressed explicit intent — the same
          // intent the "Start now" path acts on, which bypasses evaluateIssue
          // entirely — so a manual queue overrides the heuristic (issue #240).
          // On the auto path the verdict must be made observable rather than
          // silently dropped: route it to needs-human with the reasons, then
          // skip this tick.
          if (verdict.decision === "needs_review" && !manual) {
            await routeNeedsReview(repo, forge, gh, labelNames, verdict.reasons);
            continue;
          }
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

  // Credential watchdog (issue #177): notify on the failed↔healthy edge and
  // kick a probe round when one is due (on startup, then every interval).
  // Fire-and-forget with an in-flight guard inside the sweep — a slow `gh`
  // or GitLab probe must never block this tick's job claims.
  void notifyCredentialEdge(getCredentialFailures(db), credentialEdgeState, db);
  try {
    if (shouldRunCredentialProbe()) {
      const credentialProbe =
        deps.credentialProbe ?? ((d: DB) => runCredentialProbeSweep({ db: d }));
      void Promise.resolve(credentialProbe(db)).catch((err) =>
        logError("[driver] credential probe round failed", err),
      );
    }
  } catch (err) {
    logError("[driver] credential watchdog sweep failed", err);
  }

  // Reclaim leases that lapsed while the process was alive (e.g. a worker
  // whose heartbeat stopped without crashing the process). Startup recovery
  // uses requeueExpiredLeases({}) which requeues all working jobs; here we
  // only reclaim leases whose expiry has actually passed mid-run.
  requeueExpiredLeases({ expiredBefore: Math.floor(Date.now() / 1000) }, db);

  // Kill agent subprocesses whose job row another process (e.g. the MCP
  // server's abort_job) flipped to `aborted`: the abort registry is in-memory,
  // so a cross-process abort can only be signalled through the DB.
  try {
    const killed = reconcileExternalAborts(db);
    if (killed.length > 0) {
      console.log(`[driver] aborted ${killed.length} externally-aborted job(s)`);
    }
  } catch (err) {
    logError("[driver] external-abort reconcile failed", err);
  }

  // Per-agent usage-limit gates (issues #166/#167): while an agent's latch
  // blocks, its jobs stay queued (other agents proceed); once it clears,
  // parked jobs requeue so this very tick's claim loop picks them straight
  // back up. The edge notifications fire once on entering and once on clearing.
  const latchedAgents: AgentId[] = [];
  for (const agent of AGENT_IDS) {
    const latch = agentLimitBlocked(agent, db);
    void notifyProviderLimitEdge(agent, !!latch, providerLimitStates[agent], db);
    if (latch) {
      latchedAgents.push(agent);
      continue;
    }
    try {
      await resumeLimitParkedJobs(agent, repos, deps, db);
    } catch (err) {
      logError(`[driver] ${agent} limit-parked job resume sweep failed`, err);
    }
  }
  const excludeAgents = latchedAgents.length > 0 ? latchedAgents : undefined;

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
    const claimed = claimNext(
      { repoIds: eligible, worker, leaseMs: DEFAULT_LEASE_MS, excludeAgents },
      db,
    );
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
  // Serialized against webhook-triggered sweeps (issue #180) so two sweeps
  // never process the same PR's feedback concurrently.
  const reviewFeedback = deps.reviewFeedback ?? ((d: DB) => runReviewFeedbackSweep({ db: d }));
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

  // Branch & PR janitor (issue #181): delete merged drydock/* branches, update
  // stale-but-clean PRs, and escalate conflicted ones. Low priority like the
  // other background sweeps so its forge calls yield to active jobs.
  const branchJanitor = deps.branchJanitor ?? ((d: DB) => runBranchJanitorSweep({ db: d }));
  try {
    await withPriority("low", () => branchJanitor(db));
  } catch (err) {
    logError("[driver] branch-janitor sweep failed", err);
  }

  // URL-tracked PR babysitting (issue #293): reconcile every PR an operator
  // added by URL — CI status, auto-merge (opt-in), review feedback, needs-human
  // handoff. Low priority like the other background sweeps; not gated on a
  // repo's watch scope (a direct-URL PR stays tracked regardless).
  const trackedPrs = deps.trackedPrs ?? ((d: DB) => driveTrackedPrs({ db: d }));
  try {
    await withPriority("low", () => trackedPrs(db));
  } catch (err) {
    logError("[driver] tracked-pr sweep failed", err);
  }

  // Mirror the OpenRouter model catalog (issue #169) when a refresh is due.
  // Fire-and-forget: a slow Models API must never block job claims; the
  // in-flight guard in the default sweep prevents overlapping syncs.
  try {
    const s = getSettings(db);
    if (
      s.openrouterEnabled &&
      shouldSyncCatalog({ db, refreshHours: s.openrouterCatalogRefreshHours })
    ) {
      const catalogSync = deps.openrouterCatalogSync ?? defaultOpenRouterCatalogSync;
      void Promise.resolve(catalogSync(db)).catch((err) =>
        logError("[driver] openrouter catalog sync failed", err),
      );
    }
  } catch (err) {
    logError("[driver] openrouter catalog sweep failed", err);
  }
}

/** Guard so at most one catalog sync runs at a time across ticks. */
let catalogSyncInFlight = false;

async function defaultOpenRouterCatalogSync(db: DB): Promise<void> {
  if (catalogSyncInFlight) return;
  catalogSyncInFlight = true;
  try {
    const settings = getSettings(db);
    await syncOpenRouterCatalog({ db, apiKey: resolveOpenRouterApiKey(settings) || undefined });
  } finally {
    catalogSyncInFlight = false;
  }
}

let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;
let ticking = false;
let lastTickAt: number | null = null;
let loopIntervalMs: number | null = null;

export interface StartLoopOptions {
  intervalMs?: number;
  tick?: () => Promise<void>;
}

export interface DriverLoopStatus {
  running: boolean;
  /** Epoch ms of the last tick *start*. A hung tick freezes this, so the
   * health endpoint can detect a wedged loop by its age (issue #183). */
  lastTickAt: number | null;
  intervalMs: number | null;
}

export function driverLoopStatus(): DriverLoopStatus {
  return { running, lastTickAt, intervalMs: loopIntervalMs };
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
  loopIntervalMs = intervalMs;

  const schedule = () => {
    timer = setTimeout(run, intervalMs);
  };
  const run = async () => {
    if (!running) return;
    if (!ticking) {
      ticking = true;
      lastTickAt = Date.now();
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
