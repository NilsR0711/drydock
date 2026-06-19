import { type DB, getDb } from "@/lib/db/client";
import type { Repo, TrackedPr } from "@/lib/db/schema";
import type { ForgeClient, ReviewThread } from "@/lib/forge/types";
import { repoAutomation } from "@/lib/repos/automation";
import {
  type FeedbackApplyResult,
  processPrFeedback,
  type ReviewerGate,
  type ReviewForge,
} from "./review-feedback";
import { type RunAgentOnTrackedPrDeps, runAgentOnTrackedPr } from "./tracked-pr-agent";

/**
 * Review-feedback lifecycle for a URL-tracked PR (issue #293). Reuses the same
 * trusted-reviewer gate, classification, and lifecycle engine as the issue→PR
 * path ({@link processPrFeedback}); only the owner (a tracked PR) and the apply
 * step differ. Actionable feedback is applied by an agent on the PR branch —
 * but only when the branch is one we own. On a fork PR the apply fails fast
 * with a clear reason, so the lifecycle flags it for a human instead of ever
 * pushing to a branch we do not control (the ownership guardrail).
 */
function supportsReviewThreads(forge: ForgeClient): forge is ForgeClient & ReviewForge {
  return (
    typeof forge.listReviewThreads === "function" &&
    typeof forge.replyToReviewThread === "function" &&
    typeof forge.updateReviewComment === "function" &&
    typeof forge.resolveReviewThread === "function" &&
    typeof forge.reactToReviewComment === "function"
  );
}

function feedbackPrompt(thread: ReviewThread): string {
  const first = thread.comments[0];
  const where = thread.path ? `${thread.path}${thread.line ? `:${thread.line}` : ""}` : "this PR";
  return [
    `A reviewer left this comment on ${where} of the current pull request:`,
    "",
    (first?.body ?? "").trim(),
    "",
    "Make only the change this comment asks for. Do not address anything else.",
    "When done, ensure the working tree builds and tests pass, then stop — the",
    "commit and push are handled for you.",
  ].join("\n");
}

export interface DriveTrackedPrFeedbackDeps {
  db?: DB;
  agent?: RunAgentOnTrackedPrDeps;
}

export async function driveTrackedPrFeedback(
  tracked: TrackedPr,
  repo: Repo,
  forge: ForgeClient,
  deps: DriveTrackedPrFeedbackDeps = {},
): Promise<void> {
  const db = deps.db ?? getDb();
  const automation = repoAutomation(repo);
  if (!automation.autoReviewFeedback) return;
  if (!supportsReviewThreads(forge)) return;

  const gate: ReviewerGate = {
    trustedReviewers: automation.trustedReviewers,
    trustedBots: automation.trustedBots,
    ignoredBots: automation.ignoredBots,
  };

  const owned = !tracked.isFork;
  const applyFeedback = async (
    _item: unknown,
    thread: ReviewThread,
  ): Promise<FeedbackApplyResult> => {
    if (!owned) {
      return { ok: false, detail: "cannot push a fix to a fork PR branch" };
    }
    const pushed = await runAgentOnTrackedPr(
      tracked,
      repo,
      {
        prompt: feedbackPrompt(thread),
        commitMessage: `Address review feedback on ${thread.path ?? "PR"}`,
        type: "pr_feedback",
        key: `pr-fb-${tracked.id}-${thread.id}`,
      },
      { db, ...deps.agent },
    );
    return pushed ? { ok: true } : { ok: false, detail: "no change produced" };
  };

  await processPrFeedback({ trackedPrId: tracked.id }, tracked.prNumber, {
    forge,
    db,
    gate,
    includeProgressReplies: automation.includeProgressReplies,
    applyFeedback,
  });
}
