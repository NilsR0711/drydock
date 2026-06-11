"use server";

import { revalidatePath } from "next/cache";
import { getAgentProvider } from "@/lib/agents/registry";
import { getDb } from "@/lib/db/client";
import { getRepo } from "@/lib/db/queries";
import { getForge } from "@/lib/forge/registry";
import type { ForgeClient } from "@/lib/forge/types";
import { commandForAgent } from "@/lib/orchestrator/agent-command";
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
  type ReleaseRunSummary,
  recentReleaseRuns,
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
  const active = activeReleaseRun(repo.id, db);
  if (active) {
    throw new Error(
      `A release run is already in progress for this repo (run ${active.id}, ${active.status}).`,
    );
  }
  const run = createReleaseRun({ repoId: repo.id, mode: "manual" }, db);
  await withReleaseEvaluator({ provider, command, model }, (generate) =>
    publishRelease(run.id, { repo, forge, db, generate }),
  );
  revalidatePath(`/repos/${repoId}`);
  return recentReleaseRuns(repo.id, db);
}
