import { getAgentProvider } from "@/lib/agents/registry";
import { type DB, getDb } from "@/lib/db/client";
import type { Repo, TrackedPr } from "@/lib/db/schema";
import type { ForgeClient } from "@/lib/forge/types";
import { type Worktree, WorktreeManager } from "@/lib/git/worktree";
import { logError } from "@/lib/log/logger";
import { getSettings } from "@/lib/settings/service";
import { commandForAgent } from "./agent-command";
import { type OneShotType, runOneShotAndRecordCost } from "./one-shot-runner";

/**
 * Shared agent plumbing for URL-tracked PR work (issue #293). Tracked PRs have
 * no originating job, so agent runs go through the decoupled one-shot path
 * (cost is recorded to `oneShotCosts`, scoped to the repo) rather than the
 * job-keyed session machinery. Both the CI-heal and review-feedback drivers
 * reuse {@link runAgentOnTrackedPr} to check out the PR branch in an isolated
 * worktree, run the agent there, commit + push, and tear the worktree down.
 *
 * The branch is only ever a same-repo branch we own — callers gate on
 * ownership before invoking this — so the push respects the guardrail of never
 * touching a branch we do not control.
 */
export interface TrackedPrWorktrees {
  prepareForBranch(repo: Repo, branch: string, key: string): Promise<Worktree>;
  commitAndPush(wt: Worktree, message: string): Promise<void>;
  remove(wt: Worktree, repoPath: string): Promise<void>;
}

export interface RunAgentOnTrackedPrDeps {
  db?: DB;
  worktrees?: TrackedPrWorktrees;
  /** Run a one-shot agent call in the worktree; returns its exit code. */
  runAgent?: (repo: Repo, prompt: string, cwd: string, type: OneShotType) => Promise<number>;
}

/**
 * Check out a tracked PR's branch, run the agent against `prompt`, then commit
 * and push. Returns whether a change was actually pushed (a clean tree or a
 * non-zero agent exit reports `false` so the caller can hand off to a human).
 */
export async function runAgentOnTrackedPr(
  tracked: TrackedPr,
  repo: Repo,
  opts: { prompt: string; commitMessage: string; type: OneShotType; key: string },
  deps: RunAgentOnTrackedPrDeps = {},
): Promise<boolean> {
  if (!tracked.branch) return false;
  const db = deps.db ?? getDb();
  const worktrees = deps.worktrees ?? new WorktreeManager();
  const runAgent = deps.runAgent ?? defaultRunAgent(db);

  const wt = await worktrees.prepareForBranch(repo, tracked.branch, opts.key);
  try {
    const exitCode = await runAgent(repo, opts.prompt, wt.path, opts.type);
    if (exitCode !== 0) return false;
    try {
      await worktrees.commitAndPush(wt, opts.commitMessage);
    } catch {
      return false; // nothing staged — the agent produced no change.
    }
    return true;
  } finally {
    try {
      await worktrees.remove(wt, repo.path);
    } catch (err) {
      logError(`[tracked-pr] worktree cleanup failed for PR #${tracked.prNumber}`, err);
    }
  }
}

function defaultRunAgent(db: DB) {
  return async (repo: Repo, prompt: string, cwd: string, type: OneShotType): Promise<number> => {
    const provider = getAgentProvider(repo.agent);
    const command = commandForAgent(provider, db);
    const settings = getSettings(db);
    const timeoutMs = (repo.maxJobMinutes ?? settings.maxJobMinutes) * 60_000;
    const res = await runOneShotAndRecordCost({
      provider,
      command,
      model: repo.defaultModel,
      cwd,
      prompt,
      repoId: repo.id,
      type,
      timeoutMs,
      db,
    });
    return res.exitCode;
  };
}

/** Build the CI-fix prompt for a tracked PR from its failed run log. */
export function trackedPrCiFixPrompt(forge: ForgeClient, failedLog: string): string {
  return [
    "The CI checks on the current pull request are failing.",
    "",
    failedLog.trim()
      ? "Here is the tail of the failing CI log:\n\n```\n" + failedLog.trim() + "\n```"
      : "No CI log was available; inspect the checks and the diff to find the failure.",
    "",
    "Fix the failing checks with the smallest change that makes CI pass. Do not make",
    "unrelated changes. When done, ensure the working tree builds and tests pass, then",
    "stop — the commit and push are handled for you.",
  ].join("\n");
}
