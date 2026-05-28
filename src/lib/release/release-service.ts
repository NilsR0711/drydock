import { and, desc, eq } from "drizzle-orm";
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

export type ReleaseMode = "auto" | "manual";

export interface CreateReleaseRunInput {
  repoId: number;
  mode: ReleaseMode;
  /** The merged PR and its merge commit SHA (auto runs); omit for manual runs. */
  triggerPrNumber?: number | null;
  triggerSha?: string | null;
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
    })
    .returning()
    .get();
}

export function getReleaseRun(id: number, db: DB = getDb()): ReleaseRun | undefined {
  return db.select().from(releaseRuns).where(eq(releaseRuns.id, id)).get();
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

export interface ReleaseRunSummary {
  id: number;
  mode: string;
  status: string;
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
      triggerPrNumber: r.triggerPrNumber,
      fromTag: r.fromTag,
      tag: r.tag,
      title: r.title,
      prNumbers: parsePrNumbers(r.prNumbers),
      errorMessage: r.errorMessage,
      updatedAt: r.updatedAt,
    }));
}
