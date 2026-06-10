import { getAgentProvider } from "@/lib/agents/registry";
import { type DB, getDb } from "@/lib/db/client";
import { listRepos } from "@/lib/db/queries";
import type { Job, Repo } from "@/lib/db/schema";
import { getForge } from "@/lib/forge/registry";
import type { ForgeClient } from "@/lib/forge/types";
import { logError } from "@/lib/log/logger";
import { dispatch } from "@/lib/notify/notifier";
import type { ReleaseEvaluationGenerator } from "@/lib/release/release";
import { createReleaseRun, findReleaseRunByTriggerPr } from "@/lib/release/release-service";
import { repoAutomation } from "@/lib/repos/automation";
import { getSettings } from "@/lib/settings/service";
import { commandForAgent } from "./agent-command";
import { listJobs } from "./jobs";
import { publishRelease, type ReleaseForge, withReleaseEvaluator } from "./release-driver";

/**
 * Background sweep that drives the opt-in auto release path (issue #59, ADR 028)
 * for every repo that has opted in, gated behind the global kill-switch. After a
 * job's PR merges, a release run is created (deduped on the PR's head SHA so one
 * merge yields one run) and walked through the evaluate → version → publish
 * pipeline. Per-repo and per-job failures are isolated so one bad release never
 * stalls the sweep, which runs at low rate-limit priority from the driver tick.
 */

export interface DriveReleaseManagementDeps {
  db?: DB;
  forgeFor?: (repo: Repo) => ForgeClient;
  /** Build the evaluation generator for a repo (tests inject a fake). */
  generatorFor?: (repo: Repo) => ReleaseEvaluationGenerator;
  /** Notification sink; defaults to the configured channels. */
  notify?: (event: "release_published", text: string) => Promise<void>;
  now?: () => number;
  /** Only jobs merged within this window (ms) are picked up. */
  windowMs?: number;
}

/** One hour: a merge older than this is considered already handled (or stale). */
const DEFAULT_WINDOW_MS = 60 * 60 * 1000;

/** A forge supports releases only if it implements the optional release methods. */
function asReleaseForge(forge: ForgeClient): ReleaseForge | null {
  if (
    typeof forge.listReleases === "function" &&
    typeof forge.listMergedPrs === "function" &&
    typeof forge.createRelease === "function"
  ) {
    return forge as ReleaseForge;
  }
  return null;
}

/** Default generator: a one-shot agent run in a throwaway dir, per evaluation. */
function defaultGeneratorFor(repo: Repo, db: DB): ReleaseEvaluationGenerator {
  const provider = getAgentProvider(repo.agent);
  const command = commandForAgent(provider, db);
  const model = repo.defaultModel;
  return (input) => withReleaseEvaluator({ provider, command, model }, (gen) => gen(input));
}

export async function driveReleaseManagement(deps: DriveReleaseManagementDeps = {}): Promise<void> {
  const db = deps.db ?? getDb();
  // Global kill-switch: the whole feature is off unless explicitly enabled.
  if (!getSettings(db).releaseManagementEnabled) return;
  const now = deps.now ?? Date.now;
  const windowMs = deps.windowMs ?? DEFAULT_WINDOW_MS;
  const notify =
    deps.notify ?? ((event: "release_published", text: string) => dispatch(event, text, db));

  for (const repo of listRepos(db)) {
    if (!repoAutomation(repo).releaseEnabled) continue;
    try {
      const forgeClient = deps.forgeFor?.(repo) ?? getForge(repo);
      const forge = asReleaseForge(forgeClient);
      if (!forge) continue; // this forge has no release support (e.g. GitLab)
      const generate = deps.generatorFor?.(repo) ?? defaultGeneratorFor(repo, db);
      await processRepo(repo, forgeClient, forge, generate, { db, now, windowMs, notify });
    } catch (err) {
      logError(`[release] sweep failed for ${repo.name}`, err);
    }
  }
}

interface ProcessDeps {
  db: DB;
  now: () => number;
  windowMs: number;
  notify: (event: "release_published", text: string) => Promise<void>;
}

async function processRepo(
  repo: Repo,
  forgeClient: ForgeClient,
  forge: ReleaseForge,
  generate: ReleaseEvaluationGenerator,
  deps: ProcessDeps,
): Promise<void> {
  const { db, now, windowMs } = deps;
  for (const job of listJobs(repo.id, db)) {
    if (job.status !== "merged" || job.prNumber == null) continue;
    const finishedMs = (job.finishedAt ?? job.createdAt) * 1000;
    if (now() - finishedMs > windowMs) continue; // too old to pick up
    try {
      await processMergedJob(repo, job, forgeClient, forge, generate, deps);
    } catch (err) {
      logError(`[release] job ${job.id} failed for ${repo.name}`, err);
    }
  }
}

async function processMergedJob(
  repo: Repo,
  job: Job,
  forgeClient: ForgeClient,
  forge: ReleaseForge,
  generate: ReleaseEvaluationGenerator,
  deps: ProcessDeps,
): Promise<void> {
  const { db, notify } = deps;
  const prNumber = job.prNumber as number;
  // Cheap DB-only idempotency pre-check: when this PR already produced a run
  // that moved past `detected` (published, skipped, errored, or mid-flight),
  // skip without spending a forge API call on every sweep of the merge window.
  const existing = findReleaseRunByTriggerPr(repo.id, prNumber, db);
  if (existing && existing.status !== "detected") return;
  const headSha = await forgeClient.prHeadSha(prNumber);
  const run = createReleaseRun(
    { repoId: repo.id, mode: "auto", triggerPrNumber: prNumber, triggerSha: headSha },
    db,
  );
  // Only a freshly detected run is processed; an existing run (already published,
  // skipped, errored, or mid-flight) is left alone so the sweep is idempotent.
  if (run.status !== "detected") return;

  const final = await publishRelease(run.id, { repo, forge, db, generate });
  if (final.status === "published" && final.tag) {
    await notify("release_published", `🚀 Released ${repo.name} ${final.tag}.`);
  }
}
