import { and, asc, eq } from "drizzle-orm";
import { type DB, getDb } from "@/lib/db/client";
import { type IssueSubtask, issueSubtasks, issues, type Repo } from "@/lib/db/schema";
import {
  assertSubtaskTransition,
  SUBTASK_TERMINAL_STATES,
  type SubtaskStatus,
} from "@/lib/orchestrator/subtask-state";
import {
  computeBodyHash,
  type DecomposeInput,
  decompose,
  type SubtaskGenerator,
} from "./decompose";

/**
 * Persistence and the idempotent decomposition orchestrator for tracked
 * subtasks (issue #19). Pure decision logic lives in `decompose.ts`; this module
 * owns the rows and the "should we redo it?" bookkeeping, so it is exhaustively
 * testable against an in-memory DB without spawning an agent.
 */

/** A repo's subtasks for one issue, in the order they should be worked. */
export function listSubtasks(
  repoId: number,
  issueNumber: number,
  db: DB = getDb(),
): IssueSubtask[] {
  return db
    .select()
    .from(issueSubtasks)
    .where(and(eq(issueSubtasks.repoId, repoId), eq(issueSubtasks.issueNumber, issueNumber)))
    .orderBy(asc(issueSubtasks.ordinal))
    .all();
}

/**
 * Replace an issue's subtasks wholesale with `titles` (ordinals 0..n), stamping
 * each row with `bodyHash`. An empty list clears the issue's subtasks. Runs in a
 * transaction so a re-decomposition never leaves a half-written set.
 */
export function replaceSubtasks(
  repoId: number,
  issueNumber: number,
  titles: string[],
  bodyHash: string,
  db: DB = getDb(),
): IssueSubtask[] {
  return db.transaction((tx) => {
    tx.delete(issueSubtasks)
      .where(and(eq(issueSubtasks.repoId, repoId), eq(issueSubtasks.issueNumber, issueNumber)))
      .run();
    titles.forEach((title, ordinal) => {
      tx.insert(issueSubtasks).values({ repoId, issueNumber, ordinal, title, bodyHash }).run();
    });
    return tx
      .select()
      .from(issueSubtasks)
      .where(and(eq(issueSubtasks.repoId, repoId), eq(issueSubtasks.issueNumber, issueNumber)))
      .orderBy(asc(issueSubtasks.ordinal))
      .all();
  });
}

/** Transition one subtask, validating against the lifecycle state machine. */
export function transitionSubtask(id: number, to: SubtaskStatus, db: DB = getDb()): IssueSubtask {
  const row = db.select().from(issueSubtasks).where(eq(issueSubtasks.id, id)).get();
  if (!row) throw new Error(`subtask ${id} not found`);
  assertSubtaskTransition(row.status as SubtaskStatus, to);
  return db
    .update(issueSubtasks)
    .set({ status: to })
    .where(eq(issueSubtasks.id, id))
    .returning()
    .get();
}

export interface SubtaskProgress {
  total: number;
  pending: number;
  inProgress: number;
  done: number;
  skipped: number;
  deferred: number;
  /** Every subtask has reached a terminal state (done/skipped), and there is at least one. */
  complete: boolean;
}

function isTerminal(status: string): boolean {
  return (SUBTASK_TERMINAL_STATES as readonly string[]).includes(status);
}

/** Aggregate subtask status counts for an issue (for progress reporting / UI). */
export function subtaskProgress(
  repoId: number,
  issueNumber: number,
  db: DB = getDb(),
): SubtaskProgress {
  const rows = listSubtasks(repoId, issueNumber, db);
  const count = (s: SubtaskStatus) => rows.filter((r) => r.status === s).length;
  return {
    total: rows.length,
    pending: count("pending"),
    inProgress: count("in_progress"),
    done: count("done"),
    skipped: count("skipped"),
    deferred: count("deferred"),
    complete: rows.length > 0 && rows.every((r) => isTerminal(r.status)),
  };
}

export interface EnsureSubtasksResult {
  subtasks: IssueSubtask[];
  source: "heuristic" | "agent" | "none";
  /** True when the issue was unchanged since the last decomposition (no work done). */
  skipped: boolean;
}

/** Record the body hash an issue was last decomposed at (skip bookkeeping). */
function stampDecomposed(repoId: number, issueNumber: number, hash: string, db: DB): void {
  db.update(issues)
    .set({ decomposedHash: hash })
    .where(and(eq(issues.repoId, repoId), eq(issues.number, issueNumber)))
    .run();
}

function currentDecomposedHash(
  repoId: number,
  issueNumber: number,
  db: DB,
): string | null | undefined {
  return db
    .select({ h: issues.decomposedHash })
    .from(issues)
    .where(and(eq(issues.repoId, repoId), eq(issues.number, issueNumber)))
    .get()?.h;
}

/**
 * Decompose an issue into subtasks if its body changed since last time, else
 * leave the existing set untouched. Idempotency is keyed on the issue body hash
 * recorded on the issue row, so an unchanged issue neither re-runs the heuristic
 * nor (crucially) re-invokes the agent fallback. Stamps the hash even when
 * nothing decomposes, so a non-decomposable issue is tried exactly once.
 */
export async function ensureSubtasks(
  repo: Repo,
  detail: DecomposeInput,
  db: DB = getDb(),
  opts: { generate?: SubtaskGenerator } = {},
): Promise<EnsureSubtasksResult> {
  const hash = computeBodyHash(detail.body);
  if (currentDecomposedHash(repo.id, detail.number, db) === hash) {
    return { subtasks: listSubtasks(repo.id, detail.number, db), source: "none", skipped: true };
  }

  const { titles, source } = await decompose(detail, { generate: opts.generate });
  const subtasks = replaceSubtasks(repo.id, detail.number, titles, hash, db);
  stampDecomposed(repo.id, detail.number, hash, db);
  return { subtasks, source, skipped: false };
}
