import { and, eq } from "drizzle-orm";
import { type DB, getDb } from "@/lib/db/client";
import { type ReviewFeedbackItem, reviewFeedbackItems } from "@/lib/db/schema";
import type { ReactionContent, ReviewThread } from "@/lib/github/gh";
import {
  assertFeedbackTransition,
  FEEDBACK_TERMINAL_STATES,
  type FeedbackStatus,
} from "./review-feedback-state";

/**
 * Persistence and pure decision logic for the PR review-feedback lifecycle
 * (issue #18). The engine that drives these against a live PR lives in
 * `review-feedback-loop.ts`; everything here is deterministic and DB-only so it
 * is exhaustively testable without a forge.
 */

/** How a reviewer comment should be handled. */
export type FeedbackClassification = "actionable" | "question" | "out_of_scope";

/** The trusted-reviewer / trusted-bot / ignored-bot allowlists for one repo. */
export interface ReviewerGate {
  trustedReviewers: string[];
  trustedBots: string[];
  ignoredBots: string[];
}

/**
 * Strip the REST-style `[bot]` suffix and lowercase, so a configured
 * `cursor[bot]` matches the bare `cursor` login the GraphQL API reports for
 * bot actors (REST and GraphQL disagree on the suffix; issue #158).
 */
function normalizeBotLogin(login: string): string {
  return login.toLowerCase().replace(/\[bot\]$/, "");
}

/**
 * Whether a reviewer's feedback may be acted on. An explicit ignore-list match
 * always loses. Bot accounts must appear on the trusted-bots allowlist
 * (issue #158) — e.g. `cursor[bot]` for automated review findings; a human
 * must appear on the trusted-reviewers allowlist. Empty allowlists trust
 * nobody, keeping the feature inert until a repo opts specific reviewers or
 * bots in.
 *
 * Bot detection prefers the forge's actor type (`opts.isBot`, from GraphQL
 * `__typename`); the `[bot]` login suffix remains as a fallback because
 * GraphQL reports bot logins *without* it (`cursor`, not `cursor[bot]`), so
 * the suffix alone never matches in production. Both bot lists are compared
 * suffix-insensitively for the same reason.
 */
export function isTrustedReviewer(
  login: string,
  gate: ReviewerGate,
  opts: { isBot?: boolean } = {},
): boolean {
  const lower = login.toLowerCase();
  const bare = normalizeBotLogin(login);
  if (gate.ignoredBots.some((b) => normalizeBotLogin(b) === bare)) return false;
  if (opts.isBot || lower.endsWith("[bot]")) {
    return gate.trustedBots.some((b) => normalizeBotLogin(b) === bare);
  }
  return gate.trustedReviewers.some((r) => r.toLowerCase() === lower);
}

const OUT_OF_SCOPE =
  /\b(out of scope|follow[- ]?up|separate pr|different pr|unrelated|won'?t fix|nevermind|never mind|ignore this)\b/i;
const ACTIONABLE =
  /\b(please|change|rename|fix|add|remove|delete|use|extract|refactor|move|replace|guard|handle|update|simplify|inline|should be|consider|nit)\b/i;

/**
 * Classify a review comment by intent. Deferred feedback ("out of scope", "in a
 * follow-up") is `out_of_scope`; an imperative change request is `actionable`
 * even when it ends with a polite "can you?"; a purely interrogative comment is
 * a `question` for a human. Anything else defaults to `actionable`, since a bare
 * review comment is most often a change request.
 */
export function classifyFeedback(body: string): FeedbackClassification {
  const text = body.trim();
  if (OUT_OF_SCOPE.test(text)) return "out_of_scope";
  if (ACTIONABLE.test(text)) return "actionable";
  if (text.includes("?")) return "question";
  return "actionable";
}

/** The lifecycle state an item enters once classified. */
export function statusForClassification(c: FeedbackClassification): FeedbackStatus {
  switch (c) {
    case "actionable":
      return "queued";
    case "question":
      return "flagged";
    case "out_of_scope":
      return "rejected";
  }
}

/** A hidden marker that ties one of our replies to a specific review thread. */
export function feedbackMarker(threadId: string): string {
  return `<!-- drydock:review-feedback:${threadId} -->`;
}

/** Whether we have already replied on this thread (idempotency guard). */
export function hasOurReply(comments: { body: string }[], threadId: string): boolean {
  const marker = feedbackMarker(threadId);
  return comments.some((c) => c.body.includes(marker));
}

// --- Persistence -----------------------------------------------------------

export function getFeedbackItem(
  jobId: number,
  threadId: string,
  db: DB = getDb(),
): ReviewFeedbackItem | undefined {
  return db
    .select()
    .from(reviewFeedbackItems)
    .where(and(eq(reviewFeedbackItems.jobId, jobId), eq(reviewFeedbackItems.threadId, threadId)))
    .get();
}

/**
 * Insert (or fetch) the item tracking one review thread for a job. The
 * `(jobId, threadId)` pair is unique, so a thread seen on a later sweep reuses
 * its existing row and current lifecycle state.
 */
export function openFeedbackItem(
  input: {
    jobId: number;
    prNumber: number;
    threadId: string;
    reviewer: string;
    classification: FeedbackClassification;
  },
  db: DB = getDb(),
): ReviewFeedbackItem {
  const existing = getFeedbackItem(input.jobId, input.threadId, db);
  if (existing) return existing;
  return db
    .insert(reviewFeedbackItems)
    .values({
      jobId: input.jobId,
      prNumber: input.prNumber,
      threadId: input.threadId,
      reviewer: input.reviewer,
      classification: input.classification,
    })
    .returning()
    .get();
}

/** Transition a feedback item, validating against the lifecycle state machine. */
export function transitionFeedbackItem(
  id: number,
  to: FeedbackStatus,
  patch: { detail?: string | null } = {},
  db: DB = getDb(),
): ReviewFeedbackItem {
  const item = db.select().from(reviewFeedbackItems).where(eq(reviewFeedbackItems.id, id)).get();
  if (!item) throw new Error(`review feedback item ${id} not found`);
  assertFeedbackTransition(item.status as FeedbackStatus, to);
  return db
    .update(reviewFeedbackItems)
    .set({
      status: to,
      detail: patch.detail ?? item.detail,
      attempts: to === "in_progress" ? item.attempts + 1 : item.attempts,
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(eq(reviewFeedbackItems.id, id))
    .returning()
    .get();
}

export function listFeedbackItems(jobId: number, db: DB = getDb()): ReviewFeedbackItem[] {
  return db.select().from(reviewFeedbackItems).where(eq(reviewFeedbackItems.jobId, jobId)).all();
}

function isTerminal(status: string): boolean {
  return (FEEDBACK_TERMINAL_STATES as readonly string[]).includes(status);
}

// --- Engine ----------------------------------------------------------------

/** Hard budgets that keep one feedback sweep bounded (issue #18, ADR 019). */
export interface FeedbackBudgets {
  /** Max actionable items the agent applies in a single sweep. */
  maxItemsPerSweep: number;
  /** Max fix attempts on one item before flagging it for a human. */
  maxAttemptsPerItem: number;
}

export const DEFAULT_FEEDBACK_BUDGETS: FeedbackBudgets = {
  maxItemsPerSweep: 3,
  maxAttemptsPerItem: 2,
};

/** The forge operations the feedback loop needs; a subset of ForgeClient. */
export interface ReviewForge {
  listReviewThreads(prNumber: number): Promise<ReviewThread[]>;
  replyToReviewThread(threadId: string, body: string): Promise<void>;
  updateReviewComment(commentId: string, body: string): Promise<void>;
  resolveReviewThread(threadId: string): Promise<void>;
  reactToReviewComment(commentId: string, content: ReactionContent): Promise<void>;
}

/** Outcome of an agent fix attempt for one actionable item. */
export interface FeedbackApplyResult {
  ok: boolean;
  detail?: string;
}

export interface ProcessFeedbackDeps {
  forge: ReviewForge;
  db?: DB;
  gate: ReviewerGate;
  budgets?: FeedbackBudgets;
  /** Post incremental "working on it" replies. Off by default to avoid noise. */
  includeProgressReplies?: boolean;
  /** Apply an actionable item's fix in the PR worktree (edit, commit, push). */
  applyFeedback: (item: ReviewFeedbackItem, thread: ReviewThread) => Promise<FeedbackApplyResult>;
}

export interface FeedbackSummary {
  /** Items that moved through any lifecycle step this sweep. */
  processed: number;
  resolved: number;
  flagged: number;
  rejected: number;
  failed: number;
  /** Threads ignored: already resolved, untrusted reviewer, bot, or terminal. */
  skipped: number;
}

const ACK_REACTION: ReactionContent = "EYES";

// --- Bounded merge-conflict repair (optional) ------------------------------

export interface MergeConflictRepairDeps {
  /** Whether the PR branch currently conflicts with its base. */
  hasConflicts: () => Promise<boolean>;
  /** Attempt to rebase the branch onto its base, resolving trivial conflicts. */
  rebase: () => Promise<{ ok: boolean }>;
  /** Max rebase attempts before giving up. Defaults to 1. */
  maxAttempts?: number;
}

export interface MergeConflictRepairResult {
  resolved: boolean;
  attempts: number;
}

/**
 * Bounded, opt-in repair of a conflicting PR branch (issue #18): rebase onto the
 * base up to a small retry budget, stopping as soon as the conflict clears. A
 * branch that is already clean needs no attempt; a budget that runs out leaves
 * the conflict for a human. Never force-pushes beyond what `rebase` performs.
 */
export async function repairMergeConflicts(
  deps: MergeConflictRepairDeps,
): Promise<MergeConflictRepairResult> {
  const maxAttempts = deps.maxAttempts ?? 1;
  if (!(await deps.hasConflicts())) return { resolved: true, attempts: 0 };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { ok } = await deps.rebase();
    if (ok && !(await deps.hasConflicts())) return { resolved: true, attempts: attempt };
  }
  return { resolved: false, attempts: maxAttempts };
}

/**
 * Post our status reply on a thread, updating a prior Drydock reply in place
 * (matched by the hidden marker) instead of double-posting. Idempotent across
 * sweeps: re-running with the same message is a no-op update.
 */
async function postReply(forge: ReviewForge, thread: ReviewThread, message: string): Promise<void> {
  const marker = feedbackMarker(thread.id);
  const body = `${message}\n\n${marker}`;
  const prior = thread.comments.find((c) => c.body.includes(marker));
  if (prior) {
    await forge.updateReviewComment(prior.id, body);
  } else {
    await forge.replyToReviewThread(thread.id, body);
  }
}

/**
 * One review-feedback sweep over a PR (issue #18). Ingests review threads, acts
 * only on trusted reviewers' feedback (bots ignored), and walks each item
 * through its lifecycle: actionable items are applied by the agent (bounded by
 * the per-sweep and per-item budgets), questions are flagged for a human, and
 * out-of-scope feedback is rejected. Status replies are marker-based and
 * idempotent, threads are resolved when handled, and the PR is never merged.
 */
export async function processPrFeedback(
  jobId: number,
  prNumber: number,
  deps: ProcessFeedbackDeps,
): Promise<FeedbackSummary> {
  const db = deps.db ?? getDb();
  const budgets = deps.budgets ?? DEFAULT_FEEDBACK_BUDGETS;
  const summary: FeedbackSummary = {
    processed: 0,
    resolved: 0,
    flagged: 0,
    rejected: 0,
    failed: 0,
    skipped: 0,
  };

  const threads = await deps.forge.listReviewThreads(prNumber);
  let applied = 0;

  for (const thread of threads) {
    if (thread.isResolved) {
      summary.skipped++;
      continue;
    }
    const first = thread.comments[0];
    if (!first) {
      summary.skipped++;
      continue;
    }
    if (!isTrustedReviewer(first.author, deps.gate, { isBot: first.authorIsBot })) {
      summary.skipped++;
      continue;
    }

    const classification = classifyFeedback(first.body);
    let item = openFeedbackItem(
      { jobId, prNumber, threadId: thread.id, reviewer: first.author, classification },
      db,
    );

    if (isTerminal(item.status)) {
      summary.skipped++;
      continue;
    }

    // Recover an item stranded in `in_progress` by a crash or throw mid-apply:
    // sweeps run strictly sequentially, so an `in_progress` row at this point
    // can only be a leftover whose apply never reported back. Re-queue it so
    // the normal attempt budget decides between a retry and flagging.
    if (item.status === "in_progress") {
      item = transitionFeedbackItem(item.id, "queued", {}, db);
    }

    // Acknowledge the comment once, when first seen.
    if (item.status === "pending") {
      try {
        await deps.forge.reactToReviewComment(first.id, ACK_REACTION);
      } catch {
        // A reaction is best-effort; never let it block the lifecycle.
      }
    }

    // Classify pending items into their lifecycle entry state.
    if (item.status === "pending") {
      if (classification === "question") {
        item = transitionFeedbackItem(item.id, "flagged", {}, db);
        await postReply(
          deps.forge,
          thread,
          "Drydock: this looks like a question rather than a change request, so it's flagged for a human reviewer.",
        );
        summary.flagged++;
        summary.processed++;
        continue;
      }
      if (classification === "out_of_scope") {
        item = transitionFeedbackItem(item.id, "rejected", {}, db);
        await postReply(
          deps.forge,
          thread,
          "Drydock: treating this as out of scope for this PR — please open a follow-up issue if it should be tracked.",
        );
        await deps.forge.resolveReviewThread(thread.id);
        summary.rejected++;
        summary.processed++;
        continue;
      }
      item = transitionFeedbackItem(item.id, "queued", {}, db);
    }

    // Actionable item awaiting work.
    if (item.status === "queued") {
      if (applied >= budgets.maxItemsPerSweep) continue; // defer to next sweep
      if (item.attempts >= budgets.maxAttemptsPerItem) {
        item = transitionFeedbackItem(item.id, "flagged", {}, db);
        await postReply(
          deps.forge,
          thread,
          `Drydock: could not resolve this after ${item.attempts} attempt(s); flagging for a human.`,
        );
        summary.flagged++;
        summary.processed++;
        continue;
      }

      applied++;
      item = transitionFeedbackItem(item.id, "in_progress", {}, db);
      if (deps.includeProgressReplies) {
        await postReply(deps.forge, thread, "Drydock: working on this now…");
      }

      // A throw must never strand the item in `in_progress` (it would be
      // silently skipped forever): treat it like a failed attempt so the
      // budget below either re-queues or flags it.
      let result: FeedbackApplyResult;
      try {
        result = await deps.applyFeedback(item, thread);
      } catch (err) {
        result = { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
      summary.processed++;
      if (result.ok) {
        transitionFeedbackItem(item.id, "resolved", { detail: result.detail }, db);
        await postReply(deps.forge, thread, "Drydock: applied this change and pushed a commit. ✅");
        await deps.forge.resolveReviewThread(thread.id);
        summary.resolved++;
      } else if (item.attempts >= budgets.maxAttemptsPerItem) {
        transitionFeedbackItem(item.id, "failed", { detail: result.detail }, db);
        await postReply(
          deps.forge,
          thread,
          `Drydock: could not apply this automatically (${result.detail ?? "no change produced"}); flagging for a human.`,
        );
        summary.failed++;
      } else {
        // Retry budget remains: park back in queued for a later sweep.
        transitionFeedbackItem(item.id, "queued", { detail: result.detail }, db);
      }
    }
  }

  return summary;
}
