import { WAITABLE_LIMIT_KINDS } from "@/lib/agents/types";
import { type DB, getDb } from "@/lib/db/client";
import type { Job } from "@/lib/db/schema";
import { followupIssues } from "@/lib/db/schema";
import type { ForgeClient, PrCheck } from "@/lib/forge/types";
import { getSettings } from "@/lib/settings/service";
import type { SessionLimitInfo } from "./agent-session";
import { classifyFailure } from "./ci-failure-classifier";
import { buildFixPrompt, DEFAULT_EVIDENCE_LINES, extractEvidence } from "./ci-fix-prompt";
import {
  activeHealingRunCount,
  closeHealingSession,
  DEFAULT_HEAL_BUDGETS,
  finalizeHealingAttempt,
  type HealBudgets,
  listHealingAttempts,
  openHealingSession,
  planHealAttempt,
  recordHealingAttempt,
  transitionHealingSession,
  verifyHeal,
  verifyRerun,
  voidHealingAttempt,
} from "./ci-healing";
import { getJob, recordEvent, transitionJob } from "./jobs";
import { claudeLimitBlocked, clearProviderLimit, latchProviderLimit } from "./provider-limit";

export type CiOutcome = "pending" | "passed" | "failed";

const FAIL_STATES = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"]);
const PENDING_STATES = new Set(["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"]);

/** Reduce a set of PR checks to one outcome (SPEC §6.3). */
export function classifyChecks(checks: PrCheck[]): CiOutcome {
  if (checks.length === 0) return "pending";
  if (checks.some((c) => FAIL_STATES.has(c.state.toUpperCase()))) return "failed";
  if (checks.some((c) => PENDING_STATES.has(c.state.toUpperCase()))) return "pending";
  return "passed";
}

export const MAX_CI_RETRIES = 3;

/**
 * Outcome of one CI-fix resume attempt as observed by the babysitter. A resume
 * that timed out, hit the cost cap, failed to spawn, exited non-zero, or
 * produced no commit cannot have moved the PR head — re-polling would only
 * re-observe the same failed checks, burning the retry budget on no-ops.
 */
export interface ResumeOutcome {
  exitCode: number;
  timedOut?: boolean;
  costExceeded?: boolean;
  spawnError?: Error;
  /** True when the fix session finished but produced no commit to push. */
  noChanges?: boolean;
  /** True when an outside actor settled the job while the fix session ran. */
  settledExternally?: boolean;
  /** Provider limit/auth condition classified from the fix session (issue #166). */
  limit?: SessionLimitInfo;
}

/** Why a resume cannot have advanced the PR, or null when it may have. */
export function resumeFailureReason(outcome: ResumeOutcome): string | null {
  if (outcome.timedOut) return "CI-fix session timed out";
  if (outcome.costExceeded) return "per-job cost limit reached during the CI fix";
  if (outcome.spawnError) return `CI-fix session failed to start: ${outcome.spawnError.message}`;
  if (outcome.exitCode !== 0) return "CI-fix session exited non-zero";
  if (outcome.settledExternally) return "job was settled externally during the CI fix";
  if (outcome.noChanges) return "CI-fix session produced no changes";
  return null;
}

/** Opt-in CI auto-healing config, supplied when a repo enables `autoHealCi`. */
export interface AutoHealConfig {
  /** Resolve the PR's current head commit SHA (binds sessions, detects pushes). */
  headSha: (prNumber: number) => Promise<string>;
  /** Forge id used in failure fingerprints (e.g. "github"). */
  provider: string;
  budgets?: HealBudgets;
  /** Clock injection for tests. */
  now?: () => number;
}

export interface BabysitterDeps {
  /** Forge client (GitHub or GitLab) for PR/MR checks, merge, and comments. */
  gh: ForgeClient;
  db?: DB;
  /**
   * Resume the agent session with a CI-fix prompt (Haiku). Runs in the job's
   * worktree and commits + pushes the fix; the outcome reports whether the PR
   * head can actually have changed so the loop escalates instead of re-polling
   * an unchanged PR.
   */
  resumeSession: (job: Job, sessionId: string, failedLog: string) => Promise<ResumeOutcome>;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Safety bound for the poll loop in tests. */
  maxPolls?: number;
  /**
   * Hard wall-clock budget (ms) for CI to start and settle (issue #52). If
   * checks stay pending past this, the loop escalates to needs_human instead of
   * polling forever. Defaults to unbounded so callers must opt in to a budget.
   */
  ciWaitMs?: number;
  /** Clock injection for the wait budget (tests). */
  now?: () => number;
  /** When set, CI failures are routed through the auto-heal engine (issue #16). */
  autoHeal?: AutoHealConfig;
  /**
   * Review settle gate (issue #159, default 0 = merge immediately). After CI
   * first goes all-green the loop keeps polling for this long before merging,
   * so late bot/human reviews can land and feed the review-feedback loop
   * instead of arriving on an already-merged PR. Any regression to
   * pending/failed during the window resets the gate.
   */
  mergeGateMs?: number;
  /**
   * Whether the job's provider is currently limit-latched (issue #166); while
   * true, CI fixes are deferred (within the CI wait budget) instead of bouncing
   * off the spawn guard. Defaults to the Claude latch for claude jobs.
   */
  limitBlocked?: () => boolean;
}

/** Default latch probe: only claude jobs are gated today (issue #166). */
function defaultLimitBlocked(job: Job, db: DB): () => boolean {
  return () => job.agent === "claude" && !!claudeLimitBlocked(db);
}

/**
 * Handle a provider limit/auth condition from a CI-fix session (issue #166).
 * Returns the updated job to continue polling with (transient limit: latch,
 * restore the retry budget, back to ci_running), the parked job for an
 * auth/billing escalation, or null when the outcome carried no limit signal
 * (or auto-wait is off) and the normal failure path applies.
 */
function handleFixLimit(
  job: Job,
  prNumber: number,
  outcome: ResumeOutcome,
  db: DB,
): { job: Job; done: boolean } | null {
  const limit = outcome.limit;
  if (!limit) return null;
  if (limit.kind === "auth" || limit.kind === "billing") {
    const label = limit.kind === "auth" ? "authentication" : "billing";
    const message = `CI fix blocked by a provider ${label} error: ${limit.rawSnippet}`.slice(
      0,
      500,
    );
    recordEvent(job.id, "status", { reason: message, prNumber }, db);
    return { job: transitionJob(job.id, "needs_human", { errorMessage: message }, db), done: true };
  }
  if (!WAITABLE_LIMIT_KINDS.includes(limit.kind) || !getSettings(db).claudeLimitAutoWait) {
    return null;
  }
  // A latch bounce is not a fresh strike — the window is already recorded.
  if (!limit.latched) latchProviderLimit(limit, db);
  recordEvent(
    job.id,
    "status",
    { reason: `${limit.agent}_${limit.kind} during CI fix`, prNumber },
    db,
  );
  // The attempt never reached the PR; give the retry back and wait out the
  // latch from ci_running (the deferral gate above owns the waiting).
  return {
    job: transitionJob(job.id, "ci_running", { ciRetryCount: job.ciRetryCount - 1 }, db),
    done: false,
  };
}

/**
 * Tracks the review settle gate across polls (issue #159): `start()` opens the
 * window on the first all-green poll, `open()` reports whether the window is
 * still holding the merge back, and `reset()` clears it when checks regress so
 * a fresh green streak must settle again.
 */
function createMergeGate(gateMs: number, now: () => number) {
  let greenSince: number | undefined;
  return {
    /** Returns true when this poll opened the window (first green). */
    start(): boolean {
      if (gateMs <= 0) return false;
      if (greenSince !== undefined) return false;
      greenSince = now();
      return true;
    },
    open(): boolean {
      return gateMs > 0 && greenSince !== undefined && now() - greenSince < gateMs;
    },
    reset(): void {
      greenSince = undefined;
    },
  };
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Job states the babysitter itself drives; anything else was set by an
 * outside actor (abort, emergency stop, manual intervention). */
const BABYSAT_STATES = new Set<string>(["ci_running", "ci_failed", "retrying"]);

/**
 * Re-read the job row and return it when the babysitter must stop: an abort of
 * a `ci_running` job only flips the DB row (the abort registry covers live
 * agent subprocesses, not a polling loop), so the loop has to observe the DB —
 * otherwise it would keep polling and could merge the PR of an aborted job.
 * Returns undefined while the job is still in a CI state the loop owns.
 */
function externallySettled(jobId: number, db: DB): Job | undefined {
  const fresh = getJob(jobId, db);
  if (!fresh || BABYSAT_STATES.has(fresh.status)) return undefined;
  return fresh;
}

/** Comment on the issue, file a follow-up, and park the job for a human. */
async function escalateToHuman(
  job: Job,
  prNumber: number,
  message: string,
  deps: BabysitterDeps,
  db: DB,
): Promise<Job> {
  await deps.gh.commentIssue(job.issueNumber, `${message} Handing over to a human.`);
  const followNum = await deps.gh.createIssue(
    `Follow-up: CI keeps failing for issue #${job.issueNumber}`,
    `Job ${job.id} could not be auto-healed on PR #${prNumber}. ${message}`,
  );
  db.insert(followupIssues)
    .values({ jobId: job.id, ghIssueNumber: followNum, title: `Follow-up for #${job.issueNumber}` })
    .run();
  return transitionJob(job.id, "needs_human", { errorMessage: message.slice(0, 500) }, db);
}

/**
 * Stop polling and hand a stuck PR to a human when CI never settles (issue #52):
 * a stuck runner, a workflow that never starts, or a required check that is
 * never reported would otherwise keep the loop pending forever.
 */
async function escalateCiTimeout(
  job: Job,
  prNumber: number,
  ciWaitMs: number,
  deps: BabysitterDeps,
  db: DB,
  detail = "checks stayed pending",
): Promise<Job> {
  const minutes = Math.round(ciWaitMs / 60_000);
  const message = `CI did not complete in time (${detail} for over ${minutes} min on PR #${prNumber}).`;
  await deps.gh.commentIssue(job.issueNumber, `${message} Handing over to a human.`);
  recordEvent(job.id, "status", { reason: "ci wait budget exceeded", prNumber }, db);
  return transitionJob(job.id, "needs_human", { errorMessage: message.slice(0, 500) }, db);
}

/**
 * Poll `gh pr checks` every pollMs. All green → merge (auto). Any red → if under
 * the retry budget, pull the failed log and resume Claude with Haiku, else mark
 * needs_human, comment on the issue, and file a follow-up issue.
 *
 * When `deps.autoHeal` is set the failure path is delegated to the structured
 * classify → fix → verify loop with hard budgets (issue #16).
 */
export async function ciBabysitter(
  jobArg: Job,
  prNumber: number,
  deps: BabysitterDeps,
): Promise<Job> {
  if (deps.autoHeal) return autoHealLoop(jobArg, prNumber, deps, deps.autoHeal);

  const db = deps.db ?? getDb();
  const sleep = deps.sleep ?? defaultSleep;
  const pollMs = deps.pollMs ?? 30_000;
  const maxPolls = deps.maxPolls ?? Number.POSITIVE_INFINITY;
  const ciWaitMs = deps.ciWaitMs ?? Number.POSITIVE_INFINITY;
  const now = deps.now ?? Date.now;
  const deadline = now() + ciWaitMs;
  const gate = createMergeGate(deps.mergeGateMs ?? 0, now);
  const limitBlocked = deps.limitBlocked ?? defaultLimitBlocked(jobArg, db);
  let limitWaitLogged = false;

  let job = jobArg;
  let polls = 0;
  while (polls < maxPolls) {
    polls++;
    const settled = externallySettled(job.id, db);
    if (settled) return settled;
    const checks = await deps.gh.prChecks(prNumber);
    const outcome = classifyChecks(checks);

    if (outcome === "pending") {
      gate.reset();
      if (now() >= deadline) return escalateCiTimeout(job, prNumber, ciWaitMs, deps, db);
      await sleep(pollMs);
      continue;
    }

    if (outcome === "passed") {
      if (gate.start()) {
        recordEvent(
          job.id,
          "status",
          { reason: "merge gate: CI green, waiting for late reviews", prNumber },
          db,
        );
      }
      if (gate.open()) {
        await sleep(pollMs);
        continue;
      }
      // Last-moment re-check: the merge is irreversible, so an abort that
      // landed since the poll started must win over the green verdict.
      const aborted = externallySettled(job.id, db);
      if (aborted) return aborted;
      await deps.gh.mergePr(prNumber);
      return transitionJob(job.id, "merged", { prNumber }, db);
    }

    // failed
    gate.reset();
    // Claude limit latch (issue #166): a CI-fix resume would only bounce off
    // the spawn guard while blocked. Keep polling — bounded by the CI wait
    // budget — instead of burning the retry budget or paging a human.
    if (limitBlocked()) {
      if (now() >= deadline) {
        return escalateCiTimeout(
          job,
          prNumber,
          ciWaitMs,
          deps,
          db,
          "the provider usage limit blocked the CI fix",
        );
      }
      if (!limitWaitLogged) {
        recordEvent(
          job.id,
          "status",
          { reason: "ci fix deferred: provider limit latched", prNumber },
          db,
        );
        limitWaitLogged = true;
      }
      await sleep(pollMs);
      continue;
    }
    limitWaitLogged = false;
    job = transitionJob(job.id, "ci_failed", { prNumber }, db);
    if (job.ciRetryCount >= MAX_CI_RETRIES) {
      return escalateToHuman(job, prNumber, `CI failed ${MAX_CI_RETRIES} times.`, deps, db);
    }

    // Without a recorded session id we cannot resume; resuming with an empty id
    // would start a fresh, context-less session. Hand over to a human instead.
    if (!job.sessionId) {
      recordEvent(job.id, "status", { reason: "missing session id, cannot resume for CI fix" }, db);
      return transitionJob(
        job.id,
        "needs_human",
        { errorMessage: "CI failed but no session id to resume" },
        db,
      );
    }

    const sessionId = job.sessionId;
    job = transitionJob(job.id, "retrying", { ciRetryCount: job.ciRetryCount + 1 }, db);
    const failedLog = await deps.gh.failedRunLog(prNumber);
    // Feed a focused, line-capped evidence slice instead of the raw 8000-char
    // tail (issue #62), so the resume prompt targets the actual failure.
    const { evidence } = extractEvidence(failedLog, DEFAULT_EVIDENCE_LINES);
    const fixOutcome = await deps.resumeSession(job, sessionId, evidence);
    // Provider limit/auth from the fix session (issue #166): a transient limit
    // restores the retry budget and waits out the latch; auth/billing parks.
    const limited = handleFixLimit(job, prNumber, fixOutcome, db);
    if (limited) {
      job = limited.job;
      if (limited.done) return job;
      continue;
    }
    // A failed resume cannot have moved the PR head; escalate with the real
    // reason instead of burning the remaining retries on no-op sessions.
    const failure = resumeFailureReason(fixOutcome);
    if (failure) {
      recordEvent(job.id, "status", { reason: failure, prNumber }, db);
      return transitionJob(job.id, "needs_human", { errorMessage: failure }, db);
    }
    // A successful claude fix ends the provider-limit streak (issue #166).
    if (job.agent === "claude") clearProviderLimit("claude", db);
    job = transitionJob(job.id, "ci_running", {}, db);
    // loop again to re-poll the now-updated PR
  }

  return getJob(job.id, db) ?? job;
}

/** A heal attempt awaiting its CI verdict on the next poll. */
interface PendingHeal {
  attemptId: number;
  sessionId: number;
  beforeSha: string;
  beforeFailing: number;
  /** A re-run pushes no commit, so it is verified by failing count alone. */
  kind: "repair" | "rerun";
}

/**
 * The opt-in CI auto-heal loop (issue #16). Classifies failing checks, opens a
 * SHA-bound healing session (superseding stale ones), and — under hard budgets,
 * a cooldown, and a concurrency cap — makes one targeted fix attempt at a time.
 * Flaky failures get a forge-level re-run instead of a code fix. Each attempt
 * is verified for a real, improving change before counting; empty or
 * non-improving heals escalate to a human. Never auto-heals external/unknown
 * failures.
 */
async function autoHealLoop(
  jobArg: Job,
  prNumber: number,
  deps: BabysitterDeps,
  heal: AutoHealConfig,
): Promise<Job> {
  const db = deps.db ?? getDb();
  const sleep = deps.sleep ?? defaultSleep;
  const pollMs = deps.pollMs ?? 30_000;
  const maxPolls = deps.maxPolls ?? Number.POSITIVE_INFINITY;
  const budgets = heal.budgets ?? DEFAULT_HEAL_BUDGETS;
  const now = deps.now ?? heal.now ?? Date.now;
  const ciWaitMs = deps.ciWaitMs ?? Number.POSITIVE_INFINITY;
  const deadline = now() + ciWaitMs;
  const gate = createMergeGate(deps.mergeGateMs ?? 0, now);
  const limitBlocked = deps.limitBlocked ?? defaultLimitBlocked(jobArg, db);

  let job = jobArg;
  let pending: PendingHeal | undefined;
  let polls = 0;
  while (polls < maxPolls) {
    polls++;
    const settled = externallySettled(job.id, db);
    if (settled) {
      // Free the in-flight heal slot: nothing will drive this session again.
      if (pending) closeHealingSession(pending.sessionId, "superseded", db);
      return settled;
    }
    const checks = await deps.gh.prChecks(prNumber);
    const outcome = classifyChecks(checks);

    if (outcome === "pending") {
      gate.reset();
      if (now() >= deadline) {
        // Close the awaiting-CI session before parking the job: leaked
        // in-flight sessions count against the global concurrency cap forever.
        if (pending) closeHealingSession(pending.sessionId, "escalated", db);
        return escalateCiTimeout(job, prNumber, ciWaitMs, deps, db);
      }
      await sleep(pollMs);
      continue;
    }

    if (outcome === "passed") {
      if (gate.start()) {
        recordEvent(
          job.id,
          "status",
          { reason: "merge gate: CI green, waiting for late reviews", prNumber },
          db,
        );
      }
      // A pending heal is finalized only once the gate clears: if the window
      // surfaces a regression, the normal failure path verifies it instead.
      if (gate.open()) {
        await sleep(pollMs);
        continue;
      }
      // Last-moment re-check: the merge is irreversible, so an abort that
      // landed since the poll started must win over the green verdict.
      const aborted = externallySettled(job.id, db);
      if (aborted) {
        if (pending) closeHealingSession(pending.sessionId, "superseded", db);
        return aborted;
      }
      if (pending) {
        const after = await heal.headSha(prNumber);
        finalizeHealingAttempt(pending.attemptId, { status: "healed", afterSha: after }, db);
        transitionHealingSession(pending.sessionId, "verifying", db);
        transitionHealingSession(pending.sessionId, "healed", db);
      }
      await deps.gh.mergePr(prNumber);
      return transitionJob(job.id, "merged", { prNumber }, db);
    }

    // --- failed ---
    gate.reset();
    const failing = checks.filter((c) => FAIL_STATES.has(c.state.toUpperCase()));
    const headSha = await heal.headSha(prNumber);

    // Verify the previous attempt now that CI has re-run. A re-run leaves the
    // head SHA unchanged by design, so it is judged on failing count alone.
    if (pending) {
      const verdict =
        pending.kind === "rerun"
          ? verifyRerun({
              beforeFailingCount: pending.beforeFailing,
              afterFailingCount: failing.length,
            })
          : verifyHeal({
              beforeSha: pending.beforeSha,
              afterSha: headSha,
              beforeFailingCount: pending.beforeFailing,
              afterFailingCount: failing.length,
            });
      finalizeHealingAttempt(pending.attemptId, { status: verdict.verdict, afterSha: headSha }, db);
      const finishedSession = pending.sessionId;
      pending = undefined;
      if (verdict.verdict === "rejected") {
        transitionHealingSession(finishedSession, "verifying", db);
        transitionHealingSession(finishedSession, "escalated", db);
        return escalateToHuman(job, prNumber, `CI auto-heal: ${verdict.reason}.`, deps, db);
      }
      // progressed → keep healing on the new head. Park the finished session
      // via verifying → cooldown *before* opening the next one: left in
      // `awaiting_ci` it would occupy an in-flight slot forever (the
      // concurrency cap counts it) and a same-SHA reopen could not restart it.
      transitionHealingSession(finishedSession, "verifying", db);
      transitionHealingSession(finishedSession, "cooldown", db);
    }

    // Claude limit latch (issue #166): no heal attempt can run while blocked —
    // its fix session would only bounce off the spawn guard. Wait it out
    // within the CI wait budget before opening a session or planning. Any
    // previously pending attempt was already finalized by the block above.
    if (limitBlocked()) {
      if (now() >= deadline) {
        return escalateCiTimeout(
          job,
          prNumber,
          ciWaitMs,
          deps,
          db,
          "the provider usage limit blocked auto-heal",
        );
      }
      await sleep(pollMs);
      continue;
    }

    const session = openHealingSession(job.id, prNumber, headSha, db);
    const failedLog = await deps.gh.failedRunLog(prNumber);
    const classified = failing.map((c) => classifyFailure(heal.provider, c, failedLog));
    const priorAttempts = listHealingAttempts(session.id, db);
    const lastAttempt = priorAttempts.at(-1);
    const plan = planHealAttempt({
      failures: classified,
      attempts: priorAttempts.map((a) => ({ fingerprint: a.fingerprint })),
      lastAttemptAt: lastAttempt ? lastAttempt.createdAt * 1000 : null,
      now: now(),
      activeRuns: activeHealingRunCount(db),
      budgets,
    });

    switch (plan.action) {
      case "block": {
        closeHealingSession(session.id, "blocked", db);
        await deps.gh.commentIssue(
          job.issueNumber,
          `CI auto-heal: ${plan.reason} — not auto-fixable. Handing over to a human.`,
        );
        return transitionJob(
          job.id,
          "needs_human",
          { errorMessage: `auto-heal blocked: ${plan.reason}`.slice(0, 500) },
          db,
        );
      }
      case "escalate": {
        closeHealingSession(session.id, "escalated", db);
        return escalateToHuman(job, prNumber, `CI auto-heal: ${plan.reason}.`, deps, db);
      }
      // Both waiting branches honour the CI wait budget: without the deadline
      // check a leaked slot elsewhere (or a long cooldown) would spin this
      // loop forever, pinning the job in ci_running and stalling sequential
      // repos — the budget is only ever checked on the pending path otherwise.
      case "wait_slot": {
        if (now() >= deadline) {
          closeHealingSession(session.id, "escalated", db);
          return escalateCiTimeout(
            job,
            prNumber,
            ciWaitMs,
            deps,
            db,
            "auto-heal waited for a free healing slot",
          );
        }
        await sleep(pollMs);
        continue;
      }
      case "cooldown": {
        if (now() >= deadline) {
          closeHealingSession(session.id, "escalated", db);
          return escalateCiTimeout(
            job,
            prNumber,
            ciWaitMs,
            deps,
            db,
            "auto-heal waited out its cooldown",
          );
        }
        await sleep(Math.min(plan.waitMs, pollMs));
        continue;
      }
      case "repair": {
        const sessionId = job.sessionId;
        if (!sessionId) {
          closeHealingSession(session.id, "escalated", db);
          return escalateToHuman(job, prNumber, "CI failed but no session id to resume.", deps, db);
        }
        const attempt = recordHealingAttempt(session.id, plan.target, headSha, db);
        transitionHealingSession(session.id, "awaiting_slot", db);
        transitionHealingSession(session.id, "repairing", db);
        let failure: string | null = null;
        try {
          job = transitionJob(job.id, "ci_failed", { prNumber }, db);
          job = transitionJob(job.id, "retrying", { ciRetryCount: job.ciRetryCount + 1 }, db);

          // Targeted, category-specific fix prompt with focused, line-capped
          // evidence (issue #62) — not a generic raw-log dump.
          const prompt = buildFixPrompt({
            checkName: plan.target.checkName,
            log: failedLog,
            maxLines: budgets.maxEvidenceLines,
          });
          const fixOutcome = await deps.resumeSession(job, sessionId, prompt);
          // Provider limit/auth from the fix session (issue #166): the attempt
          // never ran against the quota window, so it must not consume heal
          // budgets nor hold the in-flight slot. Transient limits return the
          // job to ci_running and wait out the latch via the gate above.
          const limited = handleFixLimit(job, prNumber, fixOutcome, db);
          if (limited) {
            voidHealingAttempt(attempt.id, db);
            closeHealingSession(session.id, limited.done ? "escalated" : "superseded", db);
            job = limited.job;
            if (limited.done) return job;
            continue;
          }
          failure = resumeFailureReason(fixOutcome);
          if (!failure) {
            // A successful claude fix ends the provider-limit streak.
            if (job.agent === "claude") clearProviderLimit("claude", db);
            transitionHealingSession(session.id, "awaiting_ci", db);
            job = transitionJob(job.id, "ci_running", {}, db);
          }
        } catch (err) {
          // A throw here (a concurrent abort failing the job transition, the
          // resume rejecting) would otherwise leak the session in `repairing`,
          // permanently occupying the global in-flight healing slot.
          closeHealingSession(session.id, "escalated", db);
          throw err;
        }
        // The attempt never reached CI (timeout, cost cap, spawn failure,
        // non-zero exit, or no commit): finalize it as rejected and escalate
        // rather than awaiting a verdict on an unchanged head. Handled outside
        // the try so an escalation that itself throws cannot double-close the
        // already-closed session in the catch above.
        if (failure) {
          finalizeHealingAttempt(attempt.id, { status: "rejected", afterSha: null }, db);
          closeHealingSession(session.id, "escalated", db);
          return escalateToHuman(job, prNumber, `CI auto-heal: ${failure}.`, deps, db);
        }
        pending = {
          attemptId: attempt.id,
          sessionId: session.id,
          beforeSha: headSha,
          beforeFailing: failing.length,
          kind: "repair",
        };
        continue;
      }
      case "rerun": {
        // A flaky check wants a plain re-run, not a code fix. Trigger it on
        // the forge first; only a confirmed re-run counts as a heal attempt.
        const triggered = (await deps.gh.reRunFailedChecks?.(prNumber)) ?? false;
        if (!triggered) {
          closeHealingSession(session.id, "escalated", db);
          return escalateToHuman(
            job,
            prNumber,
            `CI auto-heal: flaky check "${plan.target.checkName}" requires a manual re-run (this forge cannot re-run failed checks).`,
            deps,
            db,
          );
        }
        const attempt = recordHealingAttempt(session.id, plan.target, headSha, db);
        // No agent runs for a re-run: the session skips `repairing` and the
        // job stays `ci_running` (it never stopped being babysat).
        transitionHealingSession(session.id, "awaiting_slot", db);
        transitionHealingSession(session.id, "awaiting_ci", db);
        recordEvent(
          job.id,
          "status",
          { reason: "auto-heal re-ran flaky check", checkName: plan.target.checkName, prNumber },
          db,
        );
        pending = {
          attemptId: attempt.id,
          sessionId: session.id,
          beforeSha: headSha,
          beforeFailing: failing.length,
          kind: "rerun",
        };
        continue;
      }
    }
  }

  return getJob(job.id, db) ?? job;
}
