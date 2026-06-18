"use server";

import { revalidatePath } from "next/cache";
import { detectDefaultBranch, resolveDefaultBranch } from "@/lib/git/default-branch";
import { emitDashboardChange } from "@/lib/stream/dashboard-bus";
import { addRepo, type RepoInput, removeRepo, updateRepo } from "./service";

/**
 * Detect a local clone's default branch for the Add-repo form, so the field can
 * be pre-filled with the real branch (e.g. `master`) instead of the `main`
 * default (issue #210). Falls back to "main" for blank/undetectable paths.
 */
export async function detectDefaultBranchAction(path: string): Promise<string> {
  if (!path.trim()) return "main";
  return detectDefaultBranch(path);
}

export async function addRepoAction(input: RepoInput) {
  // Detect the clone's real default branch when the caller left it unset, so
  // repos on `master` (or anything but `main`) work without manual setup and
  // do not fail the first job with "invalid ref: main" (issue #210).
  const defaultBranch = await resolveDefaultBranch(input);
  const repo = addRepo({ ...input, defaultBranch });
  revalidatePath("/");
  emitDashboardChange();
  return repo;
}

export async function updateRepoAction(id: number, input: Partial<RepoInput>) {
  const repo = updateRepo(id, input);
  revalidatePath("/");
  revalidatePath(`/repos/${id}`);
  emitDashboardChange();
  return repo;
}

export async function removeRepoAction(id: number) {
  removeRepo(id);
  revalidatePath("/");
  emitDashboardChange();
}
