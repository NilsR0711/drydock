import { getAgentProvider } from "@/lib/agents/registry";
import { type DB, getDb } from "@/lib/db/client";
import { listRepos } from "@/lib/db/queries";
import {
  type DeploymentHealingSession,
  deploymentHealingSessions,
  type Job,
  type Repo,
} from "@/lib/db/schema";
import { spawnRunner } from "@/lib/exec/runner";
import { getForge } from "@/lib/forge/registry";
import type { ForgeClient } from "@/lib/forge/types";
import { type Worktree, WorktreeManager } from "@/lib/git/worktree";
import { logError } from "@/lib/log/logger";
import { repoAutomation } from "@/lib/repos/automation";
import { commandForAgent } from "./agent-command";
import { spawnAgentSession } from "./agent-session";
import type { DeploymentContext, DeploymentPlatformAdapter } from "./deployment/adapter";
import { detectDeploymentPlatform } from "./deployment/registry";
import {
  classifyDeploymentStatus,
  DEFAULT_DEPLOYMENT_HEAL_BUDGETS,
  type DeploymentHealBudgets,
  deploymentSessionExists,
  openDeploymentHealingSession,
  pollGate,
  touchDeploymentHealingSession,
  transitionDeploymentHealingSession,
} from "./deployment-healing";
import { listJobs } from "./jobs";

/**
 * Background sweep that drives post-merge deployment healing (issue #20) for
 * every repo that has opted in. After a job's PR merges, the repo's deployment
 * platform is detected and the merged commit's deployment is polled. On failure
 * the logs are captured and a follow-up fix PR is opened. Per-repo and
 * per-session failures are isolated so one bad deployment never stalls the
 * sweep, which runs at low rate-limit priority from the driver tick.
 */

export interface DriveDeploymentHealingDeps {
  db?: DB;
  forgeFor?: (repo: Repo) => ForgeClient;
  /** Resolve the deployment adapter for a repo (null = not deployed here). */
  adapterFor?: (repo: Repo) => Promise<DeploymentPlatformAdapter | null>;
  /** Open a follow-up fix PR for a failed deployment; returns its PR number. */
  openFixPr?: (
    repo: Repo,
    job: Job,
    session: DeploymentHealingSession,
    logs: string,
  ) => Promise<number>;
  now?: () => number;
  budgets?: DeploymentHealBudgets;
}

/** Build the deployment context an adapter acts through for a repo + commit. */
function adapterContext(repo: Repo, ref: string | null): DeploymentContext {
  return { cwd: repo.path, ref, run: spawnRunner };
}

export async function driveDeploymentHealing(deps: DriveDeploymentHealingDeps = {}): Promise<void> {
  const db = deps.db ?? getDb();
  const now = deps.now ?? Date.now;
  const budgets = deps.budgets ?? DEFAULT_DEPLOYMENT_HEAL_BUDGETS;

  for (const repo of listRepos(db)) {
    if (!repoAutomation(repo).autoHealDeployments) continue;
    try {
      const forge = deps.forgeFor?.(repo) ?? getForge(repo);
      const resolveAdapter =
        deps.adapterFor ??
        ((r: Repo) => detectDeploymentPlatform(adapterContext(r, null), r.deploymentPlatform));
      const adapter = await resolveAdapter(repo);
      if (!adapter) continue; // no deployment platform for this repo

      const openFixPr = deps.openFixPr ?? defaultOpenFixPr;
      await monitorRepo(repo, forge, adapter, { db, now, budgets, openFixPr });
    } catch (err) {
      logError(`[deploy-heal] sweep failed for ${repo.name}`, err);
    }
  }
}

interface MonitorDeps {
  db: DB;
  now: () => number;
  budgets: DeploymentHealBudgets;
  openFixPr: NonNullable<DriveDeploymentHealingDeps["openFixPr"]>;
}

async function monitorRepo(
  repo: Repo,
  forge: ForgeClient,
  adapter: DeploymentPlatformAdapter,
  deps: MonitorDeps,
): Promise<void> {
  const { db, now, budgets } = deps;
  const repoJobs = listJobs(repo.id, db);

  // Phase A: open a monitoring session for each newly merged PR not yet tracked.
  for (const job of repoJobs) {
    if (job.status !== "merged" || job.prNumber == null) continue;
    const finishedMs = (job.finishedAt ?? job.createdAt) * 1000;
    if (now() - finishedMs > budgets.monitorWindowMs) continue; // too old to monitor
    // Monitor the commit that actually landed on the default branch. PRs are
    // squash-merged, so the PR head SHA never reaches the default branch and
    // no deployment would ever match it; the merge (squash) commit is the one
    // the platform deploys. Fall back to the head SHA only when the forge
    // cannot resolve a merge commit.
    let mergedSha: string;
    try {
      mergedSha =
        (await forge.prMergeCommitSha?.(job.prNumber)) ?? (await forge.prHeadSha(job.prNumber));
    } catch (err) {
      logError(`[deploy-heal] merged sha lookup failed for job ${job.id}`, err);
      continue;
    }
    if (deploymentSessionExists(job.id, mergedSha, db)) continue;
    openDeploymentHealingSession(job.id, job.prNumber, adapter.id, mergedSha, db);
  }

  // Phase B: advance every monitoring session for this repo.
  const sessions = db
    .select()
    .from(deploymentHealingSessions)
    .all()
    .filter((s) => s.status === "monitoring");
  for (const session of sessions) {
    const job = repoJobs.find((j) => j.id === session.jobId);
    if (!job) continue; // belongs to another repo
    try {
      await advanceSession(repo, job, adapter, session, deps);
    } catch (err) {
      logError(`[deploy-heal] session ${session.id} failed for ${repo.name}`, err);
    }
  }
}

async function advanceSession(
  repo: Repo,
  job: Job,
  adapter: DeploymentPlatformAdapter,
  session: DeploymentHealingSession,
  deps: MonitorDeps,
): Promise<void> {
  const { db, now, budgets } = deps;
  const gate = pollGate({
    createdAt: session.createdAt * 1000,
    lastPolledAt: session.updatedAt * 1000,
    now: now(),
    initialDelayMs: budgets.initialDelayMs,
    intervalMs: budgets.intervalMs,
    timeoutMs: budgets.timeoutMs,
  });
  if (gate === "wait") return;
  if (gate === "timeout") {
    transitionDeploymentHealingSession(session.id, "escalated", {}, db);
    return;
  }

  const ctx = adapterContext(repo, session.commitSha);
  const phase = classifyDeploymentStatus(await adapter.getStatus(ctx));
  if (phase === "ready") {
    transitionDeploymentHealingSession(session.id, "healthy", {}, db);
    return;
  }
  if (phase === "pending") {
    touchDeploymentHealingSession(session.id, db);
    return;
  }

  // phase === "error": capture logs, then open a follow-up fix PR.
  const rawLogs = await adapter.getLogs(ctx).catch(() => "");
  const logs = rawLogs.split("\n").slice(-budgets.maxLogLines).join("\n").trim();
  const failed = transitionDeploymentHealingSession(
    session.id,
    "failed",
    { logsExcerpt: logs || null },
    db,
  );
  transitionDeploymentHealingSession(session.id, "repairing", {}, db);
  try {
    const prNumber = await deps.openFixPr(repo, job, failed, logs);
    transitionDeploymentHealingSession(session.id, "repaired", { followupPrNumber: prNumber }, db);
  } catch (err) {
    logError(`[deploy-heal] fix PR failed for session ${session.id}`, err);
    transitionDeploymentHealingSession(session.id, "escalated", {}, db);
  }
}

/** Build the prompt asking the agent to fix a failed deployment from its logs. */
export function deploymentFixPrompt(session: DeploymentHealingSession, logs: string): string {
  return [
    `The deployment of the merged pull request #${session.prNumber} failed on`,
    `${session.platform} (commit ${session.commitSha.slice(0, 7)}).`,
    "",
    "Deployment logs:",
    "```",
    logs || "(no logs captured)",
    "```",
    "",
    "Diagnose the deployment failure and make the minimal change that fixes it.",
    "Ensure the project builds and tests pass, then stop — the commit, push, and",
    "pull request are handled for you.",
  ].join("\n");
}

/** Production composition: real worktree, agent session, and forge PR. */
async function defaultOpenFixPr(
  repo: Repo,
  job: Job,
  session: DeploymentHealingSession,
  logs: string,
): Promise<number> {
  const db = getDb();
  const provider = getAgentProvider(job.agent);
  const command = commandForAgent(provider, db);
  const worktrees = new WorktreeManager();
  const short = session.commitSha.slice(0, 7);
  const branch = `drydock/deploy-fix-${job.id}-${short}`;
  const forge = getForge(repo);

  const wt: Worktree = await worktrees.prepareForNewBranch(repo, branch, `${job.id}-${short}`);
  try {
    // sideSession: the monitored job is terminal (`merged`); a normal spawn
    // would force an invalid `working` transition and throw before the agent
    // ever starts, escalating every healing session instead of opening a PR.
    const result = await spawnAgentSession(job, deploymentFixPrompt(session, logs), wt.path, {
      db,
      provider,
      command,
      sideSession: true,
    });
    if (result.exitCode !== 0) throw new Error(`${provider.label} exited non-zero`);
    await worktrees.commitAndPush(
      wt,
      `Fix failed ${session.platform} deployment for PR #${session.prNumber}`,
    );
    return forge.createPr({
      head: branch,
      base: repo.defaultBranch,
      title: `Fix failed ${session.platform} deployment (PR #${session.prNumber})`,
      body: `The deployment for #${session.prNumber} (commit ${short}) failed. This PR addresses the deployment failure.`,
    });
  } finally {
    try {
      await worktrees.remove(wt, repo.path);
    } catch (err) {
      logError(`[deploy-heal] worktree cleanup failed for job ${job.id}`, err);
    }
  }
}
