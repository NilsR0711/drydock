import { type DB, getDb } from "@/lib/db/client";
import { getRepo } from "@/lib/db/queries";
import type { Job, Repo } from "@/lib/db/schema";
import { getForge } from "@/lib/forge/registry";
import type { IssueCommentRef } from "@/lib/forge/types";
import { setQueueLabelLocal } from "@/lib/issues/service";
import { logError } from "@/lib/log/logger";

/** Color/description for the auto-created needs-human label (matches driver-loop). */
const NEEDS_HUMAN_LABEL_OPTS = {
  color: "d73a4a",
  description: "Drydock parked this issue; needs a human",
} as const;

/** The forge operations the needs-human announcement uses; a subset of ForgeClient. */
export interface NeedsHumanForge {
  ensureLabel(name: string, opts?: { color?: string; description?: string }): Promise<void>;
  addLabels(issueNumber: number, labels: string[]): Promise<void>;
  removeLabels(issueNumber: number, labels: string[]): Promise<void>;
  commentIssue(issueNumber: number, body: string): Promise<void>;
  /** Optional idempotency seam: list comments to find a prior marker. */
  listIssueComments?(issueNumber: number): Promise<IssueCommentRef[]>;
  /** Optional idempotency seam: edit the prior marker comment in place. */
  updateIssueComment?(issueNumber: number, commentId: string, body: string): Promise<void>;
}

export interface AnnounceNeedsHumanDeps {
  db?: DB;
  /** Override the forge client (defaults to the repo's resolved forge). */
  forge?: NeedsHumanForge;
}

/**
 * Hidden marker keyed by job id. A requeued job keeps its id, so a second park
 * edits the same comment instead of stacking a fresh one (idempotency, ADR 019).
 */
export function needsHumanCommentMarker(jobId: number): string {
  return `<!-- drydock:needs-human:${jobId} -->`;
}

/** Build the needs-human issue comment: the marker, the reason, and where to act. */
export function needsHumanCommentBody(jobId: number, reason: string): string {
  const why = reason.trim() || "review required";
  return [
    needsHumanCommentMarker(jobId),
    `⚠️ **Drydock needs a human.** Job \`#${jobId}\` was parked and removed from the queue.`,
    "",
    `**Reason:** ${why}`,
    "",
    "Find it under **Needs human** in your Drydock dashboard, then requeue it once the blocker is cleared.",
  ].join("\n");
}

/**
 * Make a parked issue visible on its forge: set the needs-human label and drop
 * the queue label (forge + local mirror). Best-effort by construction — each
 * step is isolated so a forge outage on one never blocks the others, and a
 * caller's park is never turned into a thrown error.
 */
export async function markIssueNeedsHuman(
  repo: Repo,
  issueNumber: number,
  forge: NeedsHumanForge,
  db: DB = getDb(),
): Promise<void> {
  try {
    await forge.ensureLabel(repo.needsHumanLabel, NEEDS_HUMAN_LABEL_OPTS);
    await forge.addLabels(issueNumber, [repo.needsHumanLabel]);
  } catch (err) {
    logError(`[needs-human] failed to set needs-human label on #${issueNumber}`, err);
  }
  try {
    await forge.removeLabels(issueNumber, [repo.queueLabel]);
    setQueueLabelLocal(repo.id, issueNumber, repo.queueLabel, false, db);
  } catch (err) {
    logError(`[needs-human] failed to drop queue label on #${issueNumber}`, err);
  }
}

/**
 * Post the needs-human comment, editing the prior marker comment in place when
 * the forge supports it (idempotent retries). Lookup/edit are best-effort: any
 * upsert failure degrades to a fresh comment — a duplicate beats a lost reason.
 */
async function upsertNeedsHumanComment(
  forge: NeedsHumanForge,
  issueNumber: number,
  jobId: number,
  reason: string,
): Promise<void> {
  const marker = needsHumanCommentMarker(jobId);
  const body = needsHumanCommentBody(jobId, reason);
  if (forge.listIssueComments && forge.updateIssueComment) {
    try {
      const existing = (await forge.listIssueComments(issueNumber)).find((c) =>
        c.body.includes(marker),
      );
      if (existing) {
        await forge.updateIssueComment(issueNumber, existing.id, body);
        return;
      }
    } catch (err) {
      logError(`[needs-human] comment upsert degraded to a fresh post on #${issueNumber}`, err);
    }
  }
  await forge.commentIssue(issueNumber, body);
}

/**
 * Announce a job parked in `needs_human` on its forge issue (issue #250): set
 * the needs-human label, drop the queue label (+ local mirror), and post an
 * idempotent comment explaining why. Centralizes the GitHub-side visibility so
 * an operator never has to poll the Drydock dashboard to learn a job stalled.
 *
 * Best-effort throughout: a missing repo is a no-op and every forge call is
 * isolated, so a forge outage never propagates out of a settled park.
 */
export async function announceNeedsHuman(
  job: Job,
  deps: AnnounceNeedsHumanDeps = {},
): Promise<void> {
  const db = deps.db ?? getDb();
  const repo = getRepo(job.repoId, db);
  if (!repo) {
    logError(`[needs-human] repo ${job.repoId} not found for job ${job.id}; skipping announce`);
    return;
  }
  const forge = deps.forge ?? getForge(repo);
  await markIssueNeedsHuman(repo, job.issueNumber, forge, db);
  try {
    await upsertNeedsHumanComment(forge, job.issueNumber, job.id, job.errorMessage ?? "");
  } catch (err) {
    logError(`[needs-human] failed to comment on #${job.issueNumber}`, err);
  }
}
