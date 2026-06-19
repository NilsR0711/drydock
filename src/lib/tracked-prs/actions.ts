"use server";

import { revalidatePath } from "next/cache";
import { emitDashboardChange } from "@/lib/stream/dashboard-bus";
import { addTrackedPrByUrl } from "./resolve";
import { getTrackedPr, type TrackedPr, untrackPr } from "./service";

/**
 * Dashboard entry point for "Add PR by URL" (issue #293). Resolves and validates
 * the URL against the repo, starts tracking it, and refreshes the repo page.
 */
export async function addTrackedPrAction(
  repoId: number,
  url: string,
  autoMerge: boolean,
): Promise<TrackedPr> {
  const tracked = await addTrackedPrByUrl({ repoId, url, autoMerge });
  revalidatePath(`/repos/${repoId}`);
  emitDashboardChange();
  return tracked;
}

export async function untrackPrAction(repoId: number, trackedPrId: number): Promise<TrackedPr> {
  // Scope to the caller's repo so a mismatched payload can't stop tracking a PR
  // belonging to another repo (and revalidate the wrong page).
  const existing = getTrackedPr(trackedPrId);
  if (!existing || existing.repoId !== repoId) {
    throw new Error(`tracked PR ${trackedPrId} not found for repo ${repoId}`);
  }
  const tracked = untrackPr(trackedPrId);
  revalidatePath(`/repos/${repoId}`);
  emitDashboardChange();
  return tracked;
}
