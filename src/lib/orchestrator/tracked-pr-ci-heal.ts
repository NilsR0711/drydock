import type { Repo, TrackedPr } from "@/lib/db/schema";
import type { ForgeClient } from "@/lib/forge/types";
import { logError } from "@/lib/log/logger";
import {
  type RunAgentOnTrackedPrDeps,
  runAgentOnTrackedPr,
  trackedPrCiFixPrompt,
} from "./tracked-pr-agent";

/**
 * Default CI auto-heal for a URL-tracked PR (issue #293): pull the failing run
 * log, run the agent against the PR branch to fix it, and push. Returns whether
 * a fix was pushed. The caller (the tracked-PR sweep) only invokes this for an
 * owned (same-repo) branch with CI auto-heal enabled and budget remaining, so
 * the push never lands on a branch we do not control.
 */
export async function applyTrackedPrCiFix(
  tracked: TrackedPr,
  repo: Repo,
  forge: ForgeClient,
  deps: RunAgentOnTrackedPrDeps = {},
): Promise<boolean> {
  let failedLog = "";
  try {
    failedLog = await forge.failedRunLog(tracked.prNumber);
  } catch (err) {
    logError(`[tracked-pr] failed to fetch CI log for PR #${tracked.prNumber}`, err);
  }
  return runAgentOnTrackedPr(
    tracked,
    repo,
    {
      prompt: trackedPrCiFixPrompt(forge, failedLog),
      commitMessage: "Fix failing CI checks",
      type: "pr_heal",
      key: `pr-heal-${tracked.id}-${tracked.ciRetryCount}`,
    },
    deps,
  );
}
