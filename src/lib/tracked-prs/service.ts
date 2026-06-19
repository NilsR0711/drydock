import { and, desc, eq } from "drizzle-orm";
import { type DB, getDb } from "@/lib/db/client";
import { type TrackedPr, trackedPrs } from "@/lib/db/schema";
import { emitDashboardChange } from "@/lib/stream/dashboard-bus";

export type { TrackedPr };

/**
 * Lifecycle of a URL-tracked PR (issue #293), independent of the job state
 * machine:
 *  - `tracking`     — Drydock watches CI/reviews and may heal/merge per policy.
 *  - `needs_human`  — parked for an operator (fork PR, merge conflict, heal
 *                     budget exhausted, or no push access).
 *  - `merged`       — the PR landed (by us or by a human). Terminal.
 *  - `closed`       — the PR was closed without merging. Terminal.
 *  - `stopped`      — an operator untracked it. Re-tracking revives it.
 */
export const TRACKED_PR_STATES = [
  "tracking",
  "needs_human",
  "merged",
  "closed",
  "stopped",
] as const;

export type TrackedPrStatus = (typeof TRACKED_PR_STATES)[number];

const TRANSITIONS: Record<TrackedPrStatus, readonly TrackedPrStatus[]> = {
  tracking: ["needs_human", "merged", "closed", "stopped"],
  // An operator may resume a parked PR, or it may settle on the forge meanwhile.
  needs_human: ["tracking", "merged", "closed", "stopped"],
  merged: [],
  // A closed PR can be reopened on the forge; re-tracking moves it back.
  closed: ["tracking", "stopped"],
  stopped: ["tracking"],
};

export const TERMINAL_TRACKED_PR_STATES: readonly TrackedPrStatus[] = ["merged", "closed"];

export class InvalidTrackedPrTransitionError extends Error {
  constructor(from: TrackedPrStatus, to: TrackedPrStatus) {
    super(`invalid tracked-pr transition: ${from} -> ${to}`);
  }
}

function isTrackedPrStatus(s: string): s is TrackedPrStatus {
  return (TRACKED_PR_STATES as readonly string[]).includes(s);
}

export function getTrackedPr(id: number, db: DB = getDb()): TrackedPr | undefined {
  return db.select().from(trackedPrs).where(eq(trackedPrs.id, id)).get();
}

export function getTrackedPrByNumber(
  repoId: number,
  prNumber: number,
  db: DB = getDb(),
): TrackedPr | undefined {
  return db
    .select()
    .from(trackedPrs)
    .where(and(eq(trackedPrs.repoId, repoId), eq(trackedPrs.prNumber, prNumber)))
    .get();
}

export function listTrackedPrs(repoId: number, db: DB = getDb()): TrackedPr[] {
  return db
    .select()
    .from(trackedPrs)
    .where(eq(trackedPrs.repoId, repoId))
    .orderBy(desc(trackedPrs.createdAt))
    .all();
}

/** All actively-tracked PRs across every repo — the driver-loop sweep's input. */
export function listActiveTrackedPrs(db: DB = getDb()): TrackedPr[] {
  return db
    .select()
    .from(trackedPrs)
    .where(eq(trackedPrs.status, "tracking"))
    .orderBy(trackedPrs.id)
    .all();
}

/**
 * Begin tracking a PR by its resolved coordinates. Idempotent per
 * `(repoId, prNumber)`: an existing record is revived back to `tracking`
 * (clearing the prior error) rather than duplicated, so re-adding a parked or
 * stopped PR resumes it.
 */
export function trackPr(
  input: {
    repoId: number;
    prNumber: number;
    url: string;
    platform: string;
    autoMerge?: boolean;
  },
  db: DB = getDb(),
): TrackedPr {
  const existing = getTrackedPrByNumber(input.repoId, input.prNumber, db);
  if (existing) {
    const row = db
      .update(trackedPrs)
      .set({
        status: "tracking",
        url: input.url,
        platform: input.platform,
        autoMerge: input.autoMerge ?? existing.autoMerge,
        lastError: null,
        updatedAt: nowSec(),
      })
      .where(eq(trackedPrs.id, existing.id))
      .returning()
      .get();
    emitDashboardChange();
    return row;
  }
  const row = db
    .insert(trackedPrs)
    .values({
      repoId: input.repoId,
      prNumber: input.prNumber,
      url: input.url,
      platform: input.platform,
      autoMerge: input.autoMerge ?? false,
    })
    .returning()
    .get();
  emitDashboardChange();
  return row;
}

/** Patch reconciliation fields (branch, slugs, fork/owned, sha, title, …). */
export function updateTrackedPr(
  id: number,
  patch: Partial<Omit<TrackedPr, "id" | "repoId" | "status">>,
  db: DB = getDb(),
): TrackedPr {
  const row = db
    .update(trackedPrs)
    .set({ ...patch, updatedAt: nowSec() })
    .where(eq(trackedPrs.id, id))
    .returning()
    .get();
  if (!row) throw new Error(`tracked PR ${id} not found`);
  emitDashboardChange();
  return row;
}

/** Transition a tracked PR, validating against the lifecycle state machine. */
export function transitionTrackedPr(
  id: number,
  to: TrackedPrStatus,
  patch: Partial<Omit<TrackedPr, "id" | "repoId" | "status">> = {},
  db: DB = getDb(),
): TrackedPr {
  const current = getTrackedPr(id, db);
  if (!current) throw new Error(`tracked PR ${id} not found`);
  const from = current.status;
  if (!isTrackedPrStatus(from)) throw new Error(`tracked PR ${id} has unknown status ${from}`);
  if (from !== to && !TRANSITIONS[from].includes(to)) {
    throw new InvalidTrackedPrTransitionError(from, to);
  }
  const row = db
    .update(trackedPrs)
    .set({ ...patch, status: to, updatedAt: nowSec() })
    .where(eq(trackedPrs.id, id))
    .returning()
    .get();
  emitDashboardChange();
  return row;
}

/** Operator action: stop tracking a PR (soft — keeps the row for history). */
export function untrackPr(id: number, db: DB = getDb()): TrackedPr {
  return transitionTrackedPr(id, "stopped", {}, db);
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
