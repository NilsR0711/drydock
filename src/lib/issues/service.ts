import { type DB, getDb } from "@/lib/db/client";
import { type Issue, issues } from "@/lib/db/schema";
import type { GhIssue } from "@/lib/github/gh";
import { and, asc, eq, inArray, max } from "drizzle-orm";

/** Issues for a repo, ordered by manual priority (then number as tiebreak). */
export function listIssues(repoId: number, db: DB = getDb()): Issue[] {
  return db
    .select()
    .from(issues)
    .where(eq(issues.repoId, repoId))
    .orderBy(asc(issues.priority), asc(issues.number))
    .all();
}

/**
 * Reconcile the cached issues for a repo with a fresh GitHub fetch.
 * - existing issues keep their priority and get title/labels/state refreshed
 * - new issues are appended after the current maximum priority
 * - issues absent from the fetch are deleted
 */
export function syncIssuesFromGh(repoId: number, fetched: GhIssue[], db: DB = getDb()): void {
  const existing = db.select().from(issues).where(eq(issues.repoId, repoId)).all();
  const existingByNumber = new Map(existing.map((i) => [i.number, i]));
  const now = Math.floor(Date.now() / 1000);

  const maxRow = db
    .select({ value: max(issues.priority) })
    .from(issues)
    .where(eq(issues.repoId, repoId))
    .get();
  let nextPriority = (maxRow?.value ?? -1) + 1;

  const fetchedNumbers = new Set<number>();
  for (const gh of fetched) {
    fetchedNumbers.add(gh.number);
    const labels = JSON.stringify(gh.labels.map((l) => l.name));
    const prev = existingByNumber.get(gh.number);
    if (prev) {
      db.update(issues)
        .set({ title: gh.title, labels, state: "open", syncedAt: now })
        .where(eq(issues.id, prev.id))
        .run();
    } else {
      db.insert(issues)
        .values({
          repoId,
          number: gh.number,
          title: gh.title,
          labels,
          state: "open",
          priority: nextPriority++,
          syncedAt: now,
        })
        .run();
    }
  }

  const stale = existing.filter((i) => !fetchedNumbers.has(i.number)).map((i) => i.id);
  if (stale.length > 0) {
    db.delete(issues).where(inArray(issues.id, stale)).run();
  }
}

/** Persist a new manual ordering. `orderedNumbers` is the full list, first = highest. */
export function reorderIssues(repoId: number, orderedNumbers: number[], db: DB = getDb()): void {
  orderedNumbers.forEach((number, index) => {
    db.update(issues)
      .set({ priority: index })
      .where(and(eq(issues.repoId, repoId), eq(issues.number, number)))
      .run();
  });
}
