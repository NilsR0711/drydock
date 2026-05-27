/**
 * State machine for a single PR review-feedback item (issue #18). Each comment
 * thread from a trusted reviewer is one item that walks:
 *
 *   pending → queued → in_progress → resolved
 *
 * `pending` is the freshly ingested item before classification. Actionable
 * items move to `queued` (awaiting an agent slot), then `in_progress` while the
 * agent edits the worktree, then `resolved` once the fix is pushed and the
 * thread is resolved. A fix attempt that fails with retry budget left returns to
 * `queued` for a later sweep; once the budget is spent the item ends `failed`.
 * Non-code feedback never reaches the agent: a question is `flagged` for a human
 * and out-of-scope feedback is `rejected`.
 */
export const FEEDBACK_STATES = [
  "pending",
  "queued",
  "in_progress",
  "resolved",
  "failed",
  "rejected",
  "flagged",
] as const;

export type FeedbackStatus = (typeof FEEDBACK_STATES)[number];

export const FEEDBACK_TERMINAL_STATES: readonly FeedbackStatus[] = [
  "resolved",
  "failed",
  "rejected",
  "flagged",
];

const TRANSITIONS: Record<FeedbackStatus, readonly FeedbackStatus[]> = {
  pending: ["queued", "rejected", "flagged"],
  queued: ["in_progress", "flagged", "rejected"],
  in_progress: ["resolved", "failed", "flagged", "queued"],
  resolved: [],
  failed: [],
  rejected: [],
  flagged: [],
};

export function isFeedbackStatus(s: string): s is FeedbackStatus {
  return (FEEDBACK_STATES as readonly string[]).includes(s);
}

export function canFeedbackTransition(from: FeedbackStatus, to: FeedbackStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidFeedbackTransitionError extends Error {
  constructor(from: FeedbackStatus, to: FeedbackStatus) {
    super(`invalid feedback transition: ${from} -> ${to}`);
  }
}

export function assertFeedbackTransition(from: FeedbackStatus, to: FeedbackStatus): void {
  if (!canFeedbackTransition(from, to)) throw new InvalidFeedbackTransitionError(from, to);
}
