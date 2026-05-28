import { desc, eq } from "drizzle-orm";
import { type DB, getDb } from "@/lib/db/client";
import { type DeploymentHealingSession, deploymentHealingSessions, jobs } from "@/lib/db/schema";
import type { DeploymentStatus } from "./deployment/adapter";
import {
  assertDeploymentHealingTransition,
  type DeploymentHealingStatus,
} from "./deployment-healing-state";

/**
 * Persistence and pure planning for post-merge deployment healing (issue #20,
 * ADR 021). The driver (deployment-healing-driver.ts) composes these with the
 * deployment adapters and the agent/worktree to open follow-up fix PRs.
 */

/** Hard budgets that keep post-merge monitoring bounded. */
export interface DeploymentHealBudgets {
  /** Wait after merge before the first status poll, in milliseconds. */
  initialDelayMs: number;
  /** Minimum wait between status polls, in milliseconds. */
  intervalMs: number;
  /** Give up monitoring (escalate) after this long without a verdict, in ms. */
  timeoutMs: number;
  /** Only newly merged jobs within this window are picked up for monitoring. */
  monitorWindowMs: number;
  /** Cap on captured log lines fed into the follow-up fix PR. */
  maxLogLines: number;
}

export const DEFAULT_DEPLOYMENT_HEAL_BUDGETS: DeploymentHealBudgets = {
  initialDelayMs: 60 * 1000,
  intervalMs: 60 * 1000,
  timeoutMs: 20 * 60 * 1000,
  monitorWindowMs: 60 * 60 * 1000,
  maxLogLines: 200,
};

/** Collapse a platform status into the three outcomes the driver acts on. */
export function classifyDeploymentStatus(status: DeploymentStatus): "pending" | "ready" | "error" {
  if (status === "ready") return "ready";
  if (status === "error") return "error";
  return "pending"; // building | deploying | not_found
}

export interface PollTiming {
  /** Session creation time, in milliseconds. */
  createdAt: number;
  /** Last poll time, in milliseconds (== createdAt when never polled). */
  lastPolledAt: number;
  /** Current time, in milliseconds. */
  now: number;
  initialDelayMs: number;
  intervalMs: number;
  timeoutMs: number;
}

/**
 * Decide whether a monitoring session should poll now, keep waiting, or time
 * out. Pure and deterministic so the scheduling is exhaustively testable. The
 * initial delay holds off the first poll; the interval rate-limits subsequent
 * ones; the timeout escalates a deployment that never settled.
 */
export function pollGate(t: PollTiming): "wait" | "poll" | "timeout" {
  const elapsed = t.now - t.createdAt;
  if (elapsed < t.initialDelayMs) return "wait";
  if (elapsed >= t.timeoutMs) return "timeout";
  if (t.lastPolledAt <= t.createdAt) return "poll"; // never polled yet
  return t.now - t.lastPolledAt >= t.intervalMs ? "poll" : "wait";
}

// --- Persistence -----------------------------------------------------------

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function getDeploymentHealingSession(
  id: number,
  db: DB = getDb(),
): DeploymentHealingSession | undefined {
  return db
    .select()
    .from(deploymentHealingSessions)
    .where(eq(deploymentHealingSessions.id, id))
    .get();
}

/** Whether a session already exists for this job's merged commit. */
export function deploymentSessionExists(
  jobId: number,
  commitSha: string,
  db: DB = getDb(),
): boolean {
  return db
    .select()
    .from(deploymentHealingSessions)
    .where(eq(deploymentHealingSessions.jobId, jobId))
    .all()
    .some((s) => s.commitSha === commitSha);
}

/**
 * Open the monitoring session for a merged PR's commit, or return the existing
 * one (the `(jobId, commitSha)` pair is unique, so a merge is monitored once).
 */
export function openDeploymentHealingSession(
  jobId: number,
  prNumber: number,
  platform: string,
  commitSha: string,
  db: DB = getDb(),
): DeploymentHealingSession {
  const existing = db
    .select()
    .from(deploymentHealingSessions)
    .where(eq(deploymentHealingSessions.jobId, jobId))
    .all()
    .find((s) => s.commitSha === commitSha);
  if (existing) return existing;
  return db
    .insert(deploymentHealingSessions)
    .values({ jobId, prNumber, platform, commitSha })
    .returning()
    .get();
}

/** Transition a session, validating against the state machine. */
export function transitionDeploymentHealingSession(
  id: number,
  to: DeploymentHealingStatus,
  patch: { logsExcerpt?: string | null; followupPrNumber?: number | null } = {},
  db: DB = getDb(),
): DeploymentHealingSession {
  const session = getDeploymentHealingSession(id, db);
  if (!session) throw new Error(`deployment healing session ${id} not found`);
  assertDeploymentHealingTransition(session.status as DeploymentHealingStatus, to);
  return db
    .update(deploymentHealingSessions)
    .set({ status: to, updatedAt: nowSeconds(), ...patch })
    .where(eq(deploymentHealingSessions.id, id))
    .returning()
    .get();
}

/** Record that a session was polled (bumps the poll clock without a transition). */
export function touchDeploymentHealingSession(id: number, db: DB = getDb()): void {
  db.update(deploymentHealingSessions)
    .set({ updatedAt: nowSeconds() })
    .where(eq(deploymentHealingSessions.id, id))
    .run();
}

export interface DeploymentHealingSessionSummary {
  id: number;
  jobId: number;
  issueNumber: number;
  prNumber: number;
  platform: string;
  commitSha: string;
  status: string;
  followupPrNumber: number | null;
  updatedAt: number;
}

/** Recent deployment-healing sessions for a repo, newest first. */
export function recentDeploymentHealingSessions(
  repoId: number,
  db: DB = getDb(),
  limit = 10,
): DeploymentHealingSessionSummary[] {
  return db
    .select({
      id: deploymentHealingSessions.id,
      jobId: deploymentHealingSessions.jobId,
      issueNumber: jobs.issueNumber,
      prNumber: deploymentHealingSessions.prNumber,
      platform: deploymentHealingSessions.platform,
      commitSha: deploymentHealingSessions.commitSha,
      status: deploymentHealingSessions.status,
      followupPrNumber: deploymentHealingSessions.followupPrNumber,
      updatedAt: deploymentHealingSessions.updatedAt,
    })
    .from(deploymentHealingSessions)
    .innerJoin(jobs, eq(jobs.id, deploymentHealingSessions.jobId))
    .where(eq(jobs.repoId, repoId))
    .orderBy(desc(deploymentHealingSessions.updatedAt))
    .limit(limit)
    .all();
}
