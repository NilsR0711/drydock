"use server";

import { getRepo } from "@/lib/db/queries";
import { GhClient } from "@/lib/github/gh";
import { listIssues, reorderIssues, syncIssuesFromGh } from "@/lib/issues/service";
import { createJob } from "@/lib/orchestrator/jobs";
import { revalidatePath } from "next/cache";

/** Fetch issues from GitHub by the repo's queue label and cache them. */
export async function syncRepoIssuesAction(repoId: number) {
  const repo = getRepo(repoId);
  if (!repo) throw new Error(`repo ${repoId} not found`);
  const gh = new GhClient(repo.path);
  const fetched = await gh.listIssues(repo.queueLabel);
  syncIssuesFromGh(repoId, fetched);
  revalidatePath(`/repos/${repoId}`);
  return listIssues(repoId);
}

/** Persist a new manual ordering for the repo's issue queue. */
export async function reorderIssuesAction(repoId: number, orderedNumbers: number[]) {
  reorderIssues(repoId, orderedNumbers);
  revalidatePath(`/repos/${repoId}`);
}

/** Create a queued job for a single issue (the repo's default model applies). */
export async function startIssueAction(repoId: number, issueNumber: number) {
  const repo = getRepo(repoId);
  if (!repo) throw new Error(`repo ${repoId} not found`);
  const job = createJob({ repoId, issueNumber, model: repo.defaultModel });
  revalidatePath(`/repos/${repoId}`);
  return job;
}
