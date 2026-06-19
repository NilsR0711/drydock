"use server";

import { revalidatePath } from "next/cache";
import { emitDashboardChange } from "@/lib/stream/dashboard-bus";
import { addTrackedPrByUrl } from "./resolve";
import { type TrackedPr, untrackPr } from "./service";

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
  const tracked = untrackPr(trackedPrId);
  revalidatePath(`/repos/${repoId}`);
  emitDashboardChange();
  return tracked;
}
