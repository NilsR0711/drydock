import { logError } from "@/lib/log/logger";
import type { IssueCommentRef } from "./types";

/**
 * The minimal forge surface for an idempotent marker-comment upsert. The two
 * edit seams are optional: a forge without them (or a fake in tests) degrades
 * to a plain {@link UpsertCommentForge.commentIssue} post.
 */
export interface UpsertCommentForge {
  commentIssue(issueNumber: number, body: string): Promise<void>;
  listIssueComments?(issueNumber: number): Promise<IssueCommentRef[]>;
  updateIssueComment?(issueNumber: number, commentId: string, body: string): Promise<void>;
}

export interface UpsertPrCommentForge {
  commentPr(prNumber: number, body: string): Promise<void>;
  listPrComments?(prNumber: number): Promise<IssueCommentRef[]>;
  updatePrComment?(prNumber: number, commentId: string, body: string): Promise<void>;
}

/**
 * The three comment operations the upsert needs against one target (an issue or
 * a PR/MR number). `list`/`update` are optional: a forge (or fake) without them
 * degrades to a plain {@link CommentSeam.post}.
 */
interface CommentSeam {
  post(target: number, body: string): Promise<void>;
  list?(target: number): Promise<IssueCommentRef[]>;
  update?(target: number, commentId: string, body: string): Promise<void>;
}

/**
 * Post `body` as an idempotent comment on `target` keyed by a hidden `marker`
 * (issue #289). When the seam can list and edit comments and a prior comment
 * carrying the marker exists, edit it in place; otherwise post a fresh comment.
 * Lookup/edit are best-effort — any failure degrades to a fresh post, because a
 * duplicate comment beats a lost message. This is the ADR 019 idempotency
 * pattern, shared across every Drydock lifecycle comment so a re-run (or the
 * duplicate-work bug #288) edits one comment in place instead of stacking a
 * wall of bot comments.
 */
async function upsertViaSeam(
  seam: CommentSeam,
  target: number,
  marker: string,
  body: string,
  logTag: string,
): Promise<"created" | "updated"> {
  const { list, update } = seam;
  if (list && update) {
    try {
      const existing = (await list(target)).find((c) => c.body.includes(marker));
      if (existing) {
        await update(target, existing.id, body);
        return "updated";
      }
    } catch (err) {
      logError(`[${logTag}] comment upsert degraded to a fresh post on #${target}`, err);
    }
  }
  await seam.post(target, body);
  return "created";
}

/** Upsert an idempotent marker comment on an issue (ADR 019). */
export function upsertMarkerComment(
  forge: UpsertCommentForge,
  issueNumber: number,
  marker: string,
  body: string,
  logTag = "comment",
): Promise<"created" | "updated"> {
  return upsertViaSeam(
    {
      post: (n, b) => forge.commentIssue(n, b),
      list: forge.listIssueComments && ((n) => forge.listIssueComments?.(n) ?? Promise.resolve([])),
      update:
        forge.updateIssueComment &&
        ((n, id, b) => forge.updateIssueComment?.(n, id, b) ?? Promise.resolve()),
    },
    issueNumber,
    marker,
    body,
    logTag,
  );
}

/** Upsert an idempotent marker comment on a PR/MR itself (ADR 019, issue #317). */
export function upsertPrMarkerComment(
  forge: UpsertPrCommentForge,
  prNumber: number,
  marker: string,
  body: string,
  logTag = "comment",
): Promise<"created" | "updated"> {
  return upsertViaSeam(
    {
      post: (n, b) => forge.commentPr(n, b),
      list: forge.listPrComments && ((n) => forge.listPrComments?.(n) ?? Promise.resolve([])),
      update:
        forge.updatePrComment &&
        ((n, id, b) => forge.updatePrComment?.(n, id, b) ?? Promise.resolve()),
    },
    prNumber,
    marker,
    body,
    logTag,
  );
}
