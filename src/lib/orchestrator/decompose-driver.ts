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
import { RateLimitError } from "@/lib/github/rate-limit";
import { logError } from "@/lib/log/logger";
import { repoAutomation } from "@/lib/repos/automation";
import { commandForAgent } from "./agent-command";
import { agentLimitBlocked, ProviderLimitError } from "./provider-limit";
import { buildSubtaskGenerator, decomposeRepo } from "./subtask-driver";

/**
 * Standalone decomposition sweep (issue #284). Splitting large issues into
 * subtasks runs a slow `claude -p`/`codex exec` one-shot per candidate. It used
 * to be `await`ed inline in `driveTick`, *before* the enqueue and claim steps,
 * so a repo with `auto_decompose` and many candidates could keep a single tick
 * stuck for minutes — synced issues were visible as queued but never became
 * jobs, and the whole serialized loop (every other repo + the claim loop) was
 * starved with it.
 *
 * Decoupling it into its own low-priority background sweep — fired
 * fire-and-forget at the end of a tick, exactly like the review-feedback and
 * branch-janitor sweeps — means it can never block job
 * creation or job starting again. An in-flight guard ({@link runDecomposeSweep})
 * stops successive ticks from stacking overlapping sweeps for the same repos.
 */

/** The forge surface the sweep needs to find and resolve candidate issues. */
type DecomposeSweepForge = ForgeClient;

/**
 * Default per-repo decomposer: split work-candidate issues into subtasks using
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

export interface DriveDecomposeDeps {
  db?: DB;
  /** Forge client per repo (issue fetch + body/comment writes). */
  forgeFor?: (repo: Repo) => DecomposeSweepForge;
  /** Issue fetcher (injectable for tests); defaults to a metered forge listing. */
  fetchIssues?: (repoPath: string, label: string) => Promise<GhIssue[]>;
  /** Per-repo decomposition entry point (injectable for tests). */
  decompose?: (repo: Repo, forge: ForgeClient, candidates: GhIssue[], db: DB) => Promise<void>;
}

/**
 * Decompose every opted-in repo's queued/ready issues into subtasks. Per-repo
 * failures are isolated so one bad repo never stalls the sweep; a rate-limit
 * yield or a provider-limit latch simply skips that repo until the next sweep.
 */
export async function driveDecompose(deps: DriveDecomposeDeps = {}): Promise<void> {
  const db = deps.db ?? getDb();
  const decompose = deps.decompose ?? defaultDecompose;

  for (const repo of listRepos(db)) {
    const cfg = repoAutomation(repo);
    // Skip repos that have not opted in, and repos whose agent is limit-latched
    // (issue #167): every one-shot would only bounce off the exhausted quota,
    // and a limit failure mid-sweep must not stamp issues as non-decomposable.
    if (!cfg.autoDecompose) continue;
    if (agentLimitBlocked(repo.agent as AgentId, db)) continue;

    try {
      // Low priority mirrors the other background sweeps: the forge calls yield
      // the rate-limit budget to interactive routes and active jobs.
      await withPriority("low", async () => {
        const forge = deps.forgeFor?.(repo) ?? getForge(repo);
        const fetch =
          deps.fetchIssues ??
          (async (_p: string, _label: string) => {
            await forge.refreshRateLimit?.();
            return forge.listAllIssues();
          });
        const fetched = await fetch(repo.path, repo.queueLabel);

        // Bound to issues actually queued or carrying a ready label, to cap the
        // per-issue detail fetch and the LLM one-shots.
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
      if (err instanceof RateLimitError) {
        console.debug(`[decompose] ${repo.name} sweep yielded: ${err.message}`);
      } else if (err instanceof ProviderLimitError) {
        // The agent latched mid-sweep (issue #167); the next sweep resumes the
        // un-stamped candidates once the latch clears.
        console.debug(`[decompose] ${repo.name} sweep deferred: ${err.message}`);
      } else {
        logError(`[decompose] sweep failed for ${repo.name}`, err);
      }
    }
  }
}

/** Guard so at most one decompose sweep runs at a time across ticks. */
let sweepInFlight = false;

/**
 * Run a decompose sweep unless one is already in flight. The slow LLM one-shots
 * mean a sweep can outlast the poll interval; without this guard, each tick
 * would spawn another full-repo decompose on top of the running one and pile up
 * `claude -p` subprocesses. A skipped sweep is harmless — the next tick fires it.
 */
export async function runDecomposeSweep(deps: DriveDecomposeDeps = {}): Promise<void> {
  if (sweepInFlight) return;
  sweepInFlight = true;
  try {
    await driveDecompose(deps);
  } finally {
    sweepInFlight = false;
  }
}

/** Test seam: clear the in-flight guard between cases. */
export function __resetDecomposeSweep(): void {
  sweepInFlight = false;
}
