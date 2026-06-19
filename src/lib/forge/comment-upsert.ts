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

/**
 * Post `body` as an idempotent issue comment keyed by a hidden `marker`
 * (issue #289). When the forge can list and edit comments and a prior comment
 * carrying the marker exists, edit it in place; otherwise post a fresh comment.
 * Lookup/edit are best-effort — any failure degrades to a fresh post, because a
 * duplicate comment beats a lost message. This is the ADR 019 idempotency
 * pattern, shared across every Drydock lifecycle comment so a re-run (or the
 * duplicate-work bug #288) edits one comment in place instead of stacking a
 * wall of bot comments on the issue.
 */
export async function upsertMarkerComment(
  forge: UpsertCommentForge,
  issueNumber: number,
  marker: string,
  body: string,
  logTag = "comment",
): Promise<"created" | "updated"> {
  if (forge.listIssueComments && forge.updateIssueComment) {
    try {
      const existing = (await forge.listIssueComments(issueNumber)).find((c) =>
        c.body.includes(marker),
      );
      if (existing) {
        await forge.updateIssueComment(issueNumber, existing.id, body);
        return "updated";
      }
    } catch (err) {
      logError(`[${logTag}] comment upsert degraded to a fresh post on #${issueNumber}`, err);
    }
  }
  await forge.commentIssue(issueNumber, body);
  return "created";
}
