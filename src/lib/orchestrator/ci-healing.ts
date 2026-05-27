import { and, desc, eq, sql } from "drizzle-orm";
import { type DB, getDb } from "@/lib/db/client";
import {
  type HealingAttempt,
  type HealingSession,
  healingAttempts,
  healingSessions,
  jobs,
} from "@/lib/db/schema";
import type { ClassifiedFailure } from "./ci-failure-classifier";
import {
  assertHealingTransition,
  HEALING_TERMINAL_STATES,
  type HealingStatus,
} from "./ci-healing-state";

/** Hard budgets that keep auto-healing bounded (issue #16, ADR 017). */
export interface HealBudgets {
  /** Max heal attempts in one session before escalating. */
  maxHealAttemptsPerSession: number;
  /** Max attempts against a single failure fingerprint before escalating. */
  maxHealAttemptsPerFingerprint: number;
  /** Minimum wait between attempts, in milliseconds. */
  cooldownMs: number;
  /** How many healing runs may be in flight at once across all repos. */
  maxConcurrentHealingRuns: number;
  /** Cap on log lines fed to the agent as repair evidence. */
  maxEvidenceLines: number;
}

export const DEFAULT_HEAL_BUDGETS: HealBudgets = {
  maxHealAttemptsPerSession: 3,
  maxHealAttemptsPerFingerprint: 2,
  cooldownMs: 15 * 60 * 1000,
  maxConcurrentHealingRuns: 1,
  maxEvidenceLines: 200,
};

export type HealDecision =
  | { action: "repair"; target: ClassifiedFailure }
  | { action: "rerun"; target: ClassifiedFailure }
  | { action: "cooldown"; waitMs: number }
  | { action: "wait_slot" }
  | { action: "escalate"; reason: string }
  | { action: "block"; reason: string };

export interface HealPlanInput {
  /** The classified failing checks for the current head SHA. */
  failures: ClassifiedFailure[];
  /** Attempts already recorded in this session (for budget accounting). */
  attempts: { fingerprint: string }[];
  /** When the last attempt started, in ms (null if none yet). */
  lastAttemptAt: number | null;
  /** Current time, in ms. */
  now: number;
  /** In-flight healing runs across the system (for the concurrency cap). */
  activeRuns: number;
  budgets: HealBudgets;
}

/**
 * Decide the next healing action for a session given its classified failures
 * and budget state. Pure and deterministic so it is exhaustively testable.
 *
 * Precedence: a `blocked_external`-only or `unknown`-only failure set is never
 * code-healed; otherwise budgets (per-session, then per-fingerprint), the
 * concurrency cap, and the cooldown gate the chosen `repair`/`rerun` action.
 */
export function planHealAttempt(input: HealPlanInput): HealDecision {
  const { failures, attempts, budgets } = input;

  const healable = failures.filter((f) => f.category === "healable_in_branch");
  const flaky = failures.filter((f) => f.category === "flaky_or_ambiguous");
  const blocked = failures.filter((f) => f.category === "blocked_external");
  const actionable = [...healable, ...flaky];

  if (actionable.length === 0) {
    const firstBlocked = blocked[0];
    if (firstBlocked) {
      return { action: "block", reason: `external failure: ${firstBlocked.checkName}` };
    }
    return { action: "escalate", reason: "unrecognised CI failure" };
  }

  // Per-session budget: each recorded attempt counts, regardless of fingerprint.
  if (attempts.length >= budgets.maxHealAttemptsPerSession) {
    return { action: "escalate", reason: "per-session heal budget exhausted" };
  }

  // Pick one failure to address this attempt, skipping fingerprints that have
  // hit their own budget. Healable failures (code fixes) are preferred over
  // flaky ones (plain re-runs).
  const fpCount = new Map<string, number>();
  for (const a of attempts) fpCount.set(a.fingerprint, (fpCount.get(a.fingerprint) ?? 0) + 1);
  const eligible = (f: ClassifiedFailure) =>
    (fpCount.get(f.fingerprint) ?? 0) < budgets.maxHealAttemptsPerFingerprint;

  const target = healable.find(eligible) ?? flaky.find(eligible);
  if (!target) {
    return { action: "escalate", reason: "per-fingerprint heal budget exhausted" };
  }

  if (input.activeRuns >= budgets.maxConcurrentHealingRuns) {
    return { action: "wait_slot" };
  }

  if (input.lastAttemptAt != null) {
    const elapsed = input.now - input.lastAttemptAt;
    if (elapsed < budgets.cooldownMs) {
      return { action: "cooldown", waitMs: budgets.cooldownMs - elapsed };
    }
  }

  return target.category === "healable_in_branch"
    ? { action: "repair", target }
    : { action: "rerun", target };
}

export interface VerifyInput {
  beforeSha: string;
  afterSha: string;
  beforeFailingCount: number;
  afterFailingCount: number;
}

export interface VerifyResult {
  verdict: "healed" | "progressed" | "rejected";
  reason: string;
}

/**
 * Judge whether a heal attempt did real, useful work. An attempt that left the
 * head SHA unchanged produced no commit and is rejected; one that did not
 * reduce the failing-check count is rejected for lack of measurable
 * improvement. All-green is `healed`; fewer-but-nonzero is `progressed`.
 */
export function verifyHeal(input: VerifyInput): VerifyResult {
  if (input.afterSha === input.beforeSha) {
    return { verdict: "rejected", reason: "no change pushed (no new commit)" };
  }
  if (input.afterFailingCount >= input.beforeFailingCount) {
    return { verdict: "rejected", reason: "no measurable improvement in failing checks" };
  }
  if (input.afterFailingCount === 0) {
    return { verdict: "healed", reason: "all checks green" };
  }
  return { verdict: "progressed", reason: "fewer checks failing" };
}

// --- Persistence -----------------------------------------------------------

// Sessions actively consuming a run slot (not merely waiting or finished).
const IN_FLIGHT: readonly HealingStatus[] = ["repairing", "awaiting_ci", "verifying"];

function isTerminal(status: string): boolean {
  return (HEALING_TERMINAL_STATES as readonly string[]).includes(status);
}

export function getHealingSession(id: number, db: DB = getDb()): HealingSession | undefined {
  return db.select().from(healingSessions).where(eq(healingSessions.id, id)).get();
}

/**
 * Open (or reuse) the healing session for a PR at a given head SHA. Any
 * non-terminal session for the same PR on a *different* head is superseded
 * first, so a session always reflects the SHA actually under repair.
 */
export function openHealingSession(
  jobId: number,
  prNumber: number,
  headSha: string,
  db: DB = getDb(),
): HealingSession {
  const existing = db
    .select()
    .from(healingSessions)
    .where(eq(healingSessions.prNumber, prNumber))
    .all();

  for (const s of existing) {
    if (s.headSha !== headSha && !isTerminal(s.status)) {
      transitionHealingSession(s.id, "superseded", db);
    }
  }

  const sameSha = existing.find((s) => s.headSha === headSha);
  if (sameSha) return getHealingSession(sameSha.id, db) ?? sameSha;

  return db.insert(healingSessions).values({ jobId, prNumber, headSha }).returning().get();
}

/** Transition a healing session, validating against the state machine. */
export function transitionHealingSession(
  id: number,
  to: HealingStatus,
  db: DB = getDb(),
): HealingSession {
  const session = getHealingSession(id, db);
  if (!session) throw new Error(`healing session ${id} not found`);
  assertHealingTransition(session.status as HealingStatus, to);
  return db
    .update(healingSessions)
    .set({ status: to, updatedAt: Math.floor(Date.now() / 1000) })
    .where(eq(healingSessions.id, id))
    .returning()
    .get();
}

export function recordHealingAttempt(
  sessionId: number,
  failure: ClassifiedFailure,
  beforeSha: string,
  db: DB = getDb(),
): HealingAttempt {
  return db
    .insert(healingAttempts)
    .values({
      sessionId,
      fingerprint: failure.fingerprint,
      category: failure.category,
      checkName: failure.checkName,
      beforeSha,
    })
    .returning()
    .get();
}

export function finalizeHealingAttempt(
  attemptId: number,
  patch: { status: string; afterSha?: string | null },
  db: DB = getDb(),
): void {
  db.update(healingAttempts)
    .set({ status: patch.status, afterSha: patch.afterSha ?? null })
    .where(eq(healingAttempts.id, attemptId))
    .run();
}

export function listHealingAttempts(sessionId: number, db: DB = getDb()): HealingAttempt[] {
  return db.select().from(healingAttempts).where(eq(healingAttempts.sessionId, sessionId)).all();
}

export function sessionAttemptCount(sessionId: number, db: DB = getDb()): number {
  return listHealingAttempts(sessionId, db).length;
}

export function fingerprintAttemptCount(
  sessionId: number,
  fingerprint: string,
  db: DB = getDb(),
): number {
  return db
    .select()
    .from(healingAttempts)
    .where(
      and(eq(healingAttempts.sessionId, sessionId), eq(healingAttempts.fingerprint, fingerprint)),
    )
    .all().length;
}

export interface HealingSessionSummary {
  id: number;
  jobId: number;
  issueNumber: number;
  prNumber: number;
  headSha: string;
  status: string;
  attempts: number;
  updatedAt: number;
}

/** Recent healing sessions for a repo, newest first, with attempt counts. */
export function recentHealingSessions(
  repoId: number,
  db: DB = getDb(),
  limit = 10,
): HealingSessionSummary[] {
  return db
    .select({
      id: healingSessions.id,
      jobId: healingSessions.jobId,
      issueNumber: jobs.issueNumber,
      prNumber: healingSessions.prNumber,
      headSha: healingSessions.headSha,
      status: healingSessions.status,
      updatedAt: healingSessions.updatedAt,
      attempts: sql<number>`(select count(*) from ${healingAttempts} where ${healingAttempts.sessionId} = ${healingSessions.id})`,
    })
    .from(healingSessions)
    .innerJoin(jobs, eq(jobs.id, healingSessions.jobId))
    .where(eq(jobs.repoId, repoId))
    .orderBy(desc(healingSessions.updatedAt))
    .limit(limit)
    .all();
}

/** Healing runs currently occupying a slot, for the concurrency cap. */
export function activeHealingRunCount(db: DB = getDb()): number {
  return db
    .select()
    .from(healingSessions)
    .all()
    .filter((s) => (IN_FLIGHT as readonly string[]).includes(s.status)).length;
}
