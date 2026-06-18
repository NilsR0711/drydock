"use server";

import { revalidatePath } from "next/cache";
import { getAgentProvider } from "@/lib/agents/registry";
import { getDb } from "@/lib/db/client";
import { getRepo } from "@/lib/db/queries";
import { getForge } from "@/lib/forge/registry";
import type { ForgeClient } from "@/lib/forge/types";
import { commandForAgent } from "@/lib/orchestrator/agent-command";
import { enqueueJob } from "@/lib/orchestrator/queue";
import {
  previewRelease,
  publishRelease,
  type ReleaseForge,
  type ReleasePreview,
  withReleaseEvaluator,
} from "@/lib/orchestrator/release-driver";
import {
  activeReleaseRun,
  createReleaseRun,
  getReleaseRun,
  type ReleaseRunSummary,
  recentReleaseRuns,
  transitionReleaseRun,
} from "@/lib/release/release-service";
import { repoAutomation } from "@/lib/repos/automation";
import { getSettings } from "@/lib/settings/service";

/**
 * Server actions for the opt-in release manager (issue #59). The dry-run preview
 * and the manual publish both gate on the global kill-switch, the per-repo
 * opt-in, and the forge's release capability before doing anything, then reuse
 * the same evaluation pipeline as the auto path. Cutting a public release is hard
 * to reverse, so a disabled or unsupported repo fails loudly rather than guessing.
 */

/** Resolve a release-capable forge for a gated repo, or throw a clear reason. */
function releaseContext(repoId: number) {
  const db = getDb();
  const repo = getRepo(repoId, db);
  if (!repo) throw new Error(`repo ${repoId} not found`);
  if (!getSettings(db).releaseManagementEnabled) {
    throw new Error("Release management is disabled globally.");
  }
  if (!repoAutomation(repo).releaseEnabled) {
    throw new Error("Release management is not enabled for this repo.");
  }
  const client: ForgeClient = getForge(repo);
  if (
    typeof client.listReleases !== "function" ||
    typeof client.listMergedPrs !== "function" ||
    typeof client.createRelease !== "function"
  ) {
    throw new Error("This repo's forge does not support releases.");
  }
  const provider = getAgentProvider(repo.agent);
  return {
    db,
    repo,
    forge: client as ReleaseForge,
    provider,
    command: commandForAgent(provider, db),
    model: repo.defaultModel,
  };
}

/** Compute a dry-run release preview for a repo (no side effects). */
export async function previewReleaseAction(repoId: number): Promise<ReleasePreview> {
  const { forge, provider, command, model } = releaseContext(repoId);
  return withReleaseEvaluator({ provider, command, model }, (generate) =>
    previewRelease({ forge, generate }),
  );
}

/** Manually cut a release for a repo, reusing the evaluation pipeline (forced). */
export async function publishReleaseAction(repoId: number): Promise<ReleaseRunSummary[]> {
  const { db, repo, forge, provider, command, model } = releaseContext(repoId);
  // Manual runs are never deduped by trigger SHA, so guard here: a second
  // concurrent run (double submit, second tab, or a race with the auto sweep)
  // would cut a duplicate or empty release for the same PR window.
  // Guard and insert in one transaction so two concurrent submits cannot both
  // pass the check and both create a run (better-sqlite3 transactions are
  // synchronous, so no second statement can interleave).
  const run = db.transaction(() => {
    const active = activeReleaseRun(repo.id, db);
    if (active) {
      throw new Error(
        `A release run is already in progress for this repo (run ${active.id}, ${active.status}).`,
      );
    }
    return createReleaseRun({ repoId: repo.id, mode: "manual" }, db);
  });
  try {
    await withReleaseEvaluator({ provider, command, model }, (generate) =>
      publishRelease(run.id, { repo, forge, db, generate }),
    );
  } catch (err) {
    // A failure before the pipeline ever ran would leave the run in
    // `detected` — which activeReleaseRun treats as in flight, permanently
    // blocking manual publishes for this repo. Park it as a retryable error.
    const current = getReleaseRun(run.id, db);
    if (current?.status === "detected") {
      const message = err instanceof Error ? err.message : String(err);
      transitionReleaseRun(run.id, "error", { errorMessage: message.slice(0, 500) }, db);
    }
    throw err;
  }
  revalidatePath(`/repos/${repoId}`);
  return recentReleaseRuns(repo.id, db);
}

/** The result of starting an agent-driven release: the new job + the run list. */
export interface StartReleaseResult {
  jobId: number;
  runs: ReleaseRunSummary[];
}

/**
 * Start an agent-driven release for a repo (issue #256): enqueue a release job
 * whose agent discovers how the repo releases and performs it, then record a
 * linked `release_runs` row (mode "agent") so the panel shows the run and can
 * deep-link to the job's live log. Gated by the same global + per-repo opt-in
 * and forge capability as the deterministic path; additionally requires the
 * Claude agent, the only one wired for the full-shell-access release session.
 * The job's dedupe key (`release:<repoId>`) refuses a second concurrent release
 * (double submit, second tab) until the prior one settles — a release is hard to
 * reverse, so a duplicate must never slip through.
 */
export async function startReleaseAction(repoId: number): Promise<StartReleaseResult> {
  const { db, repo } = releaseContext(repoId);
  if (repo.agent !== "claude") {
    throw new Error("Agent-driven release currently supports the Claude agent only.");
  }
  // Guard, enqueue, and record in one transaction so nothing can interleave
  // (better-sqlite3 transactions are synchronous). `activeReleaseRun` also blocks
  // a deterministic auto/manual run already in flight — that path creates no job,
  // so the job dedupe key alone would not catch it, and two pipelines could cut
  // the same release. Creating the run inside the transaction closes the window
  // where a concurrent deterministic publish could slip past before it exists.
  const job = db.transaction(() => {
    const active = activeReleaseRun(repo.id, db);
    if (active) {
      throw new Error(
        `A release run is already in progress for this repo (run ${active.id}, ${active.status}).`,
      );
    }
    const created = enqueueJob(
      {
        repoId: repo.id,
        issueNumber: 0,
        kind: "release",
        agent: repo.agent,
        model: repo.defaultModel,
        dedupeKey: `release:${repo.id}`,
      },
      db,
    );
    if (!created) throw new Error("A release job is already in progress for this repo.");
    createReleaseRun({ repoId: repo.id, mode: "agent", jobId: created.id }, db);
    return created;
  });
  revalidatePath(`/repos/${repoId}`);
  return { jobId: job.id, runs: recentReleaseRuns(repo.id, db) };
}
