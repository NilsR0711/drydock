"use server";

import { revalidatePath } from "next/cache";
import { getRepo } from "@/lib/db/queries";
import { getGh } from "@/lib/issues/gh-factory";
import {
  listIssues,
  reorderIssues,
  setQueueLabelLocal,
  syncIssuesFromGh,
} from "@/lib/issues/service";
import { createJob } from "@/lib/orchestrator/jobs";

/** Fetch all open issues from GitHub and cache them (backlog + queue). */
export async function syncRepoIssuesAction(repoId: number) {
  const repo = getRepo(repoId);
  if (!repo) throw new Error(`repo ${repoId} not found`);
  const gh = getGh(repo.path);
  const fetched = await gh.listAllIssues();
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

/** Add the repo's queue label to an issue (GitHub + local cache). */
export async function addToQueueAction(repoId: number, issueNumber: number) {
  const repo = getRepo(repoId);
  if (!repo) throw new Error(`repo ${repoId} not found`);
  const gh = getGh(repo.path);
  await gh.ensureLabel(repo.queueLabel, {
    color: "1f6feb",
    description: "Queued for processing by Drydock",
  });
  await gh.addLabels(issueNumber, [repo.queueLabel]);
  setQueueLabelLocal(repoId, issueNumber, repo.queueLabel, true);
  revalidatePath(`/repos/${repoId}`);
  return listIssues(repoId);
}

/** Remove the repo's queue label from an issue (GitHub + local cache). */
export async function removeFromQueueAction(repoId: number, issueNumber: number) {
  const repo = getRepo(repoId);
  if (!repo) throw new Error(`repo ${repoId} not found`);
  await getGh(repo.path).removeLabels(issueNumber, [repo.queueLabel]);
  setQueueLabelLocal(repoId, issueNumber, repo.queueLabel, false);
  revalidatePath(`/repos/${repoId}`);
  return listIssues(repoId);
}

/** Full issue detail incl. body and comments, fetched live from GitHub. */
export async function viewIssueAction(repoId: number, issueNumber: number) {
  const repo = getRepo(repoId);
  if (!repo) throw new Error(`repo ${repoId} not found`);
  return getGh(repo.path).viewIssue(issueNumber);
}

/** Edit issue title and/or body. */
export async function editIssueAction(
  repoId: number,
  issueNumber: number,
  patch: { title?: string; body?: string },
) {
  const repo = getRepo(repoId);
  if (!repo) throw new Error(`repo ${repoId} not found`);
  await getGh(repo.path).editIssue(issueNumber, patch);
  revalidatePath(`/repos/${repoId}`);
}

/** Post a comment on an issue. */
export async function commentIssueAction(repoId: number, issueNumber: number, body: string) {
  const repo = getRepo(repoId);
  if (!repo) throw new Error(`repo ${repoId} not found`);
  await getGh(repo.path).commentIssue(issueNumber, body);
}

/** Add or remove labels on an issue (GitHub + local cache for the queue label). */
export async function setIssueLabelsAction(
  repoId: number,
  issueNumber: number,
  add: string[],
  remove: string[],
) {
  const repo = getRepo(repoId);
  if (!repo) throw new Error(`repo ${repoId} not found`);
  const gh = getGh(repo.path);
  if (add.includes(repo.queueLabel)) {
    await gh.ensureLabel(repo.queueLabel, {
      color: "1f6feb",
      description: "Queued for processing by Drydock",
    });
  }
  if (add.length) await gh.addLabels(issueNumber, add);
  if (remove.length) await gh.removeLabels(issueNumber, remove);
  if (add.includes(repo.queueLabel)) setQueueLabelLocal(repoId, issueNumber, repo.queueLabel, true);
  if (remove.includes(repo.queueLabel))
    setQueueLabelLocal(repoId, issueNumber, repo.queueLabel, false);
  revalidatePath(`/repos/${repoId}`);
}

/** Close or reopen an issue. */
export async function setIssueStateAction(
  repoId: number,
  issueNumber: number,
  state: "open" | "closed",
) {
  const repo = getRepo(repoId);
  if (!repo) throw new Error(`repo ${repoId} not found`);
  const gh = getGh(repo.path);
  if (state === "closed") await gh.closeIssue(issueNumber);
  else await gh.reopenIssue(issueNumber);
  revalidatePath(`/repos/${repoId}`);
}
