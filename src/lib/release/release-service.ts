import { and, desc, eq, inArray } from "drizzle-orm";
import { type DB, getDb } from "@/lib/db/client";
import { type ReleaseRun, releaseRuns } from "@/lib/db/schema";
import type { SemverBump } from "@/lib/version/semver";
import { assertReleaseTransition, type ReleaseStatus } from "./release-state";

/**
 * Persistence for release runs (issue #59). The driver (release-driver.ts)
 * composes these with the forge and the agent to evaluate and publish releases.
 * Idempotency lives here: an auto run dedupes on `(repoId, triggerSha)` so a
 * given merge commit yields exactly one run.
 */

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export type ReleaseMode = "auto" | "manual" | "agent";

export interface CreateReleaseRunInput {
  repoId: number;
  mode: ReleaseMode;
  /** The merged PR and its merge commit SHA (auto runs); omit for manual runs. */
  triggerPrNumber?: number | null;
  triggerSha?: string | null;
  /** The job executing an agent-driven release (mode "agent", issue #256). */
  jobId?: number | null;
}

/**
 * Create a release run, or return the existing one for an auto trigger
 * (`(repoId, triggerSha)` is unique), so one merge commit is released once.
 * Manual runs carry a null `triggerSha` and are never deduped.
 */
export function createReleaseRun(input: CreateReleaseRunInput, db: DB = getDb()): ReleaseRun {
  const triggerSha = input.triggerSha ?? null;
  if (triggerSha !== null) {
    const existing = db
      .select()
      .from(releaseRuns)
      .where(and(eq(releaseRuns.repoId, input.repoId), eq(releaseRuns.triggerSha, triggerSha)))
      .get();
    if (existing) return existing;
  }
  return db
    .insert(releaseRuns)
    .values({
      repoId: input.repoId,
      mode: input.mode,
      triggerPrNumber: input.triggerPrNumber ?? null,
      triggerSha,
      jobId: input.jobId ?? null,
    })
    .returning()
    .get();
}

export function getReleaseRun(id: number, db: DB = getDb()): ReleaseRun | undefined {
  return db.select().from(releaseRuns).where(eq(releaseRuns.id, id)).get();
}

/**
 * States in which a run is actively walking the publish pipeline. `error` runs
 * are parked (retryable), not in flight, so they never block a new run.
 */
const RELEASE_IN_FLIGHT_STATES: readonly ReleaseStatus[] = [
  "detected",
  "evaluating",
  "proposed",
  "publishing",
];

/**
 * The repo's currently in-flight release run, if any. Lets the manual publish
 * action refuse to start a second concurrent run (e.g. a double submit, or a
 * manual publish racing the auto sweep) that could cut a duplicate or empty
 * release for the same PR window.
 */
export function activeReleaseRun(repoId: number, db: DB = getDb()): ReleaseRun | undefined {
  return db
    .select()
    .from(releaseRuns)
    .where(
      and(
        eq(releaseRuns.repoId, repoId),
        inArray(releaseRuns.status, [...RELEASE_IN_FLIGHT_STATES]),
      ),
    )
    .get();
}

/**
 * The latest run triggered by a given merged PR, if any. Lets the release
 * sweep skip a PR whose run already advanced past `detected` without spending
 * a forge API call to resolve the PR's head SHA on every sweep.
 */
export function findReleaseRunByTriggerPr(
  repoId: number,
  triggerPrNumber: number,
  db: DB = getDb(),
): ReleaseRun | undefined {
  return db
    .select()
    .from(releaseRuns)
    .where(and(eq(releaseRuns.repoId, repoId), eq(releaseRuns.triggerPrNumber, triggerPrNumber)))
    .orderBy(desc(releaseRuns.id))
    .get();
}

/** The run backing a given agent-driven release job (issue #256), if any. */
export function findReleaseRunByJob(jobId: number, db: DB = getDb()): ReleaseRun | undefined {
  return db.select().from(releaseRuns).where(eq(releaseRuns.jobId, jobId)).get();
}

/** Fields a transition may set alongside the new status. */
export interface ReleaseRunPatch {
  bump?: SemverBump;
  fromTag?: string | null;
  tag?: string | null;
  title?: string | null;
  notes?: string | null;
  /** Included PR numbers; serialized to the `pr_numbers` JSON column. */
  prNumbers?: number[];
  errorMessage?: string | null;
}

/** Transition a run, validating against the state machine and bumping updatedAt. */
export function transitionReleaseRun(
  id: number,
  to: ReleaseStatus,
  patch: ReleaseRunPatch = {},
  db: DB = getDb(),
): ReleaseRun {
  const run = getReleaseRun(id, db);
  if (!run) throw new Error(`release run ${id} not found`);
  assertReleaseTransition(run.status as ReleaseStatus, to);
  const { prNumbers, ...rest } = patch;
  return db
    .update(releaseRuns)
    .set({
      status: to,
      updatedAt: nowSeconds(),
      ...rest,
      ...(prNumbers !== undefined ? { prNumbers: JSON.stringify(prNumbers) } : {}),
    })
    .where(eq(releaseRuns.id, id))
    .returning()
    .get();
}

/**
 * Settle an agent-driven release run as published (issue #256). The agent
 * already performed the release; this only records the outcome, walking the
 * shared release state machine's terminal hops (evaluating → proposed →
 * publishing → published) and stamping whatever tag/title/notes the agent
 * reported via `.drydock/RELEASE.md`. Kept here so the strict transition
 * validation stays the single source of truth for the column.
 */
export function publishAgentReleaseRun(
  id: number,
  patch: { tag?: string | null; title?: string | null; notes?: string | null } = {},
  db: DB = getDb(),
): ReleaseRun {
  transitionReleaseRun(id, "proposed", patch, db);
  transitionReleaseRun(id, "publishing", {}, db);
  return transitionReleaseRun(id, "published", {}, db);
}

export interface ReleaseRunSummary {
  id: number;
  mode: string;
  status: string;
  jobId: number | null;
  triggerPrNumber: number | null;
  fromTag: string | null;
  tag: string | null;
  title: string | null;
  prNumbers: number[];
  errorMessage: string | null;
  updatedAt: number;
}

function parsePrNumbers(json: string): number[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : [];
  } catch {
    return [];
  }
}

/** Recent release runs for a repo, newest first. */
export function recentReleaseRuns(
  repoId: number,
  db: DB = getDb(),
  limit = 10,
): ReleaseRunSummary[] {
  return db
    .select()
    .from(releaseRuns)
    .where(eq(releaseRuns.repoId, repoId))
    .orderBy(desc(releaseRuns.updatedAt), desc(releaseRuns.id))
    .limit(limit)
    .all()
    .map((r) => ({
      id: r.id,
      mode: r.mode,
      status: r.status,
      jobId: r.jobId,
      triggerPrNumber: r.triggerPrNumber,
      fromTag: r.fromTag,
      tag: r.tag,
      title: r.title,
      prNumbers: parsePrNumbers(r.prNumbers),
      errorMessage: r.errorMessage,
      updatedAt: r.updatedAt,
    }));
}
