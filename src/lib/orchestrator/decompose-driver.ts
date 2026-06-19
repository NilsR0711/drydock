import { getAgentProvider } from "@/lib/agents/registry";
import type { AgentId } from "@/lib/agents/types";
import { type DB, getDb } from "@/lib/db/client";
import { listRepos } from "@/lib/db/queries";
import type { Repo } from "@/lib/db/schema";
import type { CommandRunner } from "@/lib/exec/runner";
import { getForge } from "@/lib/forge/registry";
import type { ForgeClient } from "@/lib/forge/types";
import type { GhIssue } from "@/lib/github/gh";
import { withPriority } from "@/lib/github/priority";
import { logError } from "@/lib/log/logger";
import { repoAutomation } from "@/lib/repos/automation";
import { commandForAgent } from "./agent-command";
import { agentLimitBlocked } from "./provider-limit";
import { buildSubtaskGenerator, decomposeRepo } from "./subtask-driver";

/**
 * Opt-in issue decomposition (issue #19) driven as a standalone background
 * sweep, decoupled from the issue scheduler (issue #284).
 *
 * Decomposition runs a slow agent one-shot (`claude -p` / `codex exec`) per
 * candidate issue. It used to run inline inside the per-repo step of `driveTick`,
 * awaited before the enqueue loop — so a repo with many candidates kept the tick
 * wedged in decompose and never reached `enqueueJob`, leaving queued issues
 * visible in the UI but never turned into jobs. Worse, the whole tick is
 * serialized behind one re-entrancy latch with the claim loop at the very end,
 * so one slow decompose starved enqueue and job-starting for *every* repo.
 *
 * Moving it here, fired fire-and-forget after the claim loop with an in-flight
 * guard, keeps the per-issue one-shots permanently off the critical path: job
 * creation and claiming happen every tick regardless of how long decompose runs.
 */

export interface DriveDecomposeDeps {
  db?: DB;
  /** Forge client per repo (issue fetch + comment writes). */
  forgeFor?: (repo: Repo) => ForgeClient;
  /** Issue fetcher (injectable for tests); defaults to a metered forge list. */
  fetchIssues?: (repoPath: string, label: string) => Promise<GhIssue[]>;
  /** Per-repo decomposition step (injectable for tests). */
  decompose?: (repo: Repo, forge: ForgeClient, candidates: GhIssue[], db: DB) => Promise<void>;
}

/**
 * Default decomposition step: split work-candidate issues into subtasks using
 * an agent one-shot fallback for prose, scoped to the repo's checkout. Bounded
 * to issues actually queued/ready for work by the caller.
 *
 * Routed through the repo's {@link getAgentProvider agent provider} (issue #49):
 * a Codex repo decomposes via `codex exec` with the configured `codexPath`, a
 * Claude repo via `claude -p` with `claudePath`, using the repo's own model —
 * never the global `claudePath` with Claude-shaped flags regardless of agent.
 */
export function defaultDecompose(
  repo: Repo,
  forge: ForgeClient,
  candidates: GhIssue[],
  db: DB,
  opts: { runner?: CommandRunner } = {},
): Promise<void> {
  const provider = getAgentProvider(repo.agent);
  const generate = buildSubtaskGenerator({
    provider,
    command: commandForAgent(provider, db),
    model: repo.defaultModel,
    cwd: repo.path,
    db,
    runner: opts.runner,
  });
  return decomposeRepo(repo, forge, candidates, db, { generate });
}

/**
 * One decomposition sweep across every opted-in repo. Per repo it fetches the
 * issue list, narrows it to work candidates (queued or ready-labelled), and runs
 * the decomposition step. Repos that have not opted in, or whose agent is
 * limit-latched (issue #167) — every one-shot would only bounce off the
 * exhausted quota — are skipped. Per-repo failures are isolated so one bad repo
 * never aborts the sweep. Runs at `low` GitHub priority so its forge calls yield
 * the rate-limit budget to active jobs, mirroring the other background sweeps.
 */
export async function driveDecompose(deps: DriveDecomposeDeps = {}): Promise<void> {
  const db = deps.db ?? getDb();
  const decompose = deps.decompose ?? defaultDecompose;

  for (const repo of listRepos(db)) {
    const cfg = repoAutomation(repo);
    if (!cfg.autoDecompose) continue;
    if (agentLimitBlocked(repo.agent as AgentId, db)) continue;
    try {
      await withPriority("low", async () => {
        const forge = deps.forgeFor?.(repo) ?? getForge(repo);
        const fetch =
          deps.fetchIssues ??
          (async (_p: string, _label: string) => {
            await forge.refreshRateLimit?.();
            return forge.listAllIssues();
          });
        const fetched = await fetch(repo.path, repo.queueLabel);
        const candidates = fetched.filter((gh) => {
          const labelNames = gh.labels.map((l) => l.name);
          return (
            labelNames.includes(repo.queueLabel) ||
            labelNames.some((l) => cfg.readyLabels.includes(l))
          );
        });
        if (candidates.length === 0) return;
        await decompose(repo, forge, candidates, db);
      });
    } catch (err) {
      // A provider-limit abort latched the agent and stopped this repo's sweep
      // (issue #167); the next sweep retries it once the latch clears. Any other
      // failure is isolated to this repo so the remaining repos still decompose.
      logError(`[decompose] sweep failed for ${repo.name}`, err);
    }
  }
}

/** Guard so at most one decomposition sweep runs at a time across ticks. */
let decomposeInFlight = false;

/**
 * Run a decomposition sweep, dropping the call if one is already in flight. The
 * per-issue one-shots can outlive the poll interval, so without this guard a
 * fresh sweep every tick would pile up overlapping `claude -p` runs against the
 * same candidates. The driver fires this fire-and-forget, so a slow sweep never
 * blocks job creation or claiming.
 */
export function runDecomposeSweep(deps: DriveDecomposeDeps = {}): Promise<void> {
  if (decomposeInFlight) return Promise.resolve();
  decomposeInFlight = true;
  return driveDecompose(deps).finally(() => {
    decomposeInFlight = false;
  });
}

/** Test seam: reset the in-flight guard between cases. */
export function __resetDecomposeSweep(): void {
  decomposeInFlight = false;
}
