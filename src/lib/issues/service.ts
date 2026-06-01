import { and, asc, eq, inArray, max } from "drizzle-orm";
import { type DB, getDb } from "@/lib/db/client";
import { getRepo } from "@/lib/db/queries";
import { type Issue, issues } from "@/lib/db/schema";
import { getForge } from "@/lib/forge/registry";
import type { GhIssue } from "@/lib/github/gh";

const QUEUE_LABEL_OPTS = {
  color: "1f6feb",
  description: "Queued for processing by Drydock",
} as const;

function requireRepo(repoId: number, db: DB) {
  const repo = getRepo(repoId, db);
  if (!repo) throw new Error(`repo ${repoId} not found`);
  return repo;
}

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

/** Add or remove the queue label in the locally cached labels JSON for one issue. */
export function setQueueLabelLocal(
  repoId: number,
  number: number,
  queueLabel: string,
  inQueue: boolean,
  db: DB = getDb(),
): void {
  const row = db
    .select()
    .from(issues)
    .where(and(eq(issues.repoId, repoId), eq(issues.number, number)))
    .get();
  if (!row) return;
  let labels: string[];
  try {
    const v = JSON.parse(row.labels);
    labels = Array.isArray(v) ? v : [];
  } catch {
    labels = [];
  }
  const has = labels.includes(queueLabel);
  let next = labels;
  if (inQueue && !has) next = [...labels, queueLabel];
  if (!inQueue && has) next = labels.filter((l) => l !== queueLabel);
  db.update(issues)
    .set({ labels: JSON.stringify(next) })
    .where(eq(issues.id, row.id))
    .run();
}

/**
 * Fetch all open issues for a repo from its forge and reconcile the local cache.
 * Returns the refreshed issue list. The forge call is the only side effect
 * beyond the cache reconciliation, so both the dashboard and the MCP server can
 * share this single source of truth.
 */
export async function syncRepoIssues(repoId: number, db: DB = getDb()): Promise<Issue[]> {
  const repo = requireRepo(repoId, db);
  const fetched = await getForge(repo).listAllIssues();
  syncIssuesFromGh(repoId, fetched, db);
  return listIssues(repoId, db);
}

/** Add the repo's queue label to an issue (forge + local cache); returns issues. */
export async function queueIssue(
  repoId: number,
  issueNumber: number,
  opts: { model?: string; agent?: string } = {},
  db: DB = getDb(),
): Promise<Issue[]> {
  const repo = requireRepo(repoId, db);
  const gh = getForge(repo);
  await gh.ensureLabel(repo.queueLabel, QUEUE_LABEL_OPTS);
  await gh.addLabels(issueNumber, [repo.queueLabel]);
  setQueueLabelLocal(repoId, issueNumber, repo.queueLabel, true, db);
  if (opts.model !== undefined || opts.agent !== undefined) {
    db.update(issues)
      .set({
        modelOverride: opts.model ?? null,
        agentOverride: opts.agent ?? null,
      })
      .where(and(eq(issues.repoId, repoId), eq(issues.number, issueNumber)))
      .run();
  }
  return listIssues(repoId, db);
}

/** Remove the repo's queue label from an issue (forge + local cache); returns issues. */
export async function dequeueIssue(
  repoId: number,
  issueNumber: number,
  db: DB = getDb(),
): Promise<Issue[]> {
  const repo = requireRepo(repoId, db);
  await getForge(repo).removeLabels(issueNumber, [repo.queueLabel]);
  setQueueLabelLocal(repoId, issueNumber, repo.queueLabel, false, db);
  return listIssues(repoId, db);
}

/**
 * Queue several issues in one batch (issue #111). Ensures the queue label once
 * for the whole batch, then labels each issue sequentially (forge + local
 * cache) to avoid hammering the forge. Returns the refreshed issue list.
 */
export async function bulkQueueIssues(
  repoId: number,
  issueNumbers: number[],
  db: DB = getDb(),
): Promise<Issue[]> {
  const repo = requireRepo(repoId, db);
  if (issueNumbers.length === 0) return listIssues(repoId, db);
  const gh = getForge(repo);
  await gh.ensureLabel(repo.queueLabel, QUEUE_LABEL_OPTS);
  for (const number of issueNumbers) {
    await gh.addLabels(number, [repo.queueLabel]);
    setQueueLabelLocal(repoId, number, repo.queueLabel, true, db);
  }
  return listIssues(repoId, db);
}

/** Dequeue several issues in one batch (issue #111); returns the refreshed list. */
export async function bulkDequeueIssues(
  repoId: number,
  issueNumbers: number[],
  db: DB = getDb(),
): Promise<Issue[]> {
  const repo = requireRepo(repoId, db);
  if (issueNumbers.length === 0) return listIssues(repoId, db);
  const gh = getForge(repo);
  for (const number of issueNumbers) {
    await gh.removeLabels(number, [repo.queueLabel]);
    setQueueLabelLocal(repoId, number, repo.queueLabel, false, db);
  }
  return listIssues(repoId, db);
}

/** Apply one label across several issues in a batch (issue #111). */
export async function bulkApplyLabel(
  repoId: number,
  issueNumbers: number[],
  label: string,
  db: DB = getDb(),
): Promise<Issue[]> {
  if (issueNumbers.length === 0) return listIssues(repoId, db);
  for (const number of issueNumbers) {
    await applyIssueLabels(repoId, number, [label], [], db);
  }
  return listIssues(repoId, db);
}

/** Add and/or remove labels on an issue (forge + local cache for the queue label). */
export async function applyIssueLabels(
  repoId: number,
  issueNumber: number,
  add: string[],
  remove: string[],
  db: DB = getDb(),
): Promise<void> {
  const repo = requireRepo(repoId, db);
  const gh = getForge(repo);
  if (add.includes(repo.queueLabel)) await gh.ensureLabel(repo.queueLabel, QUEUE_LABEL_OPTS);
  if (add.length) await gh.addLabels(issueNumber, add);
  if (remove.length) await gh.removeLabels(issueNumber, remove);
  if (add.includes(repo.queueLabel))
    setQueueLabelLocal(repoId, issueNumber, repo.queueLabel, true, db);
  if (remove.includes(repo.queueLabel))
    setQueueLabelLocal(repoId, issueNumber, repo.queueLabel, false, db);
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
