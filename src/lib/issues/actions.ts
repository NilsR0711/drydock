"use server";

import { revalidatePath } from "next/cache";
import { getRepo } from "@/lib/db/queries";
import { getForge } from "@/lib/forge/registry";
import {
  applyIssueLabels,
  dequeueIssue,
  queueIssue,
  reorderIssues,
  syncRepoIssues,
} from "@/lib/issues/service";
import { listSubtasks } from "@/lib/issues/subtasks";
import { createJob } from "@/lib/orchestrator/jobs";

/** Fetch all open issues from GitHub and cache them (backlog + queue). */
export async function syncRepoIssuesAction(repoId: number) {
  const result = await syncRepoIssues(repoId);
  revalidatePath(`/repos/${repoId}`);
  return result;
}

/** Persist a new manual ordering for the repo's issue queue. */
export async function reorderIssuesAction(repoId: number, orderedNumbers: number[]) {
  reorderIssues(repoId, orderedNumbers);
  revalidatePath(`/repos/${repoId}`);
}

/** Create a queued job for a single issue. Optionally override model and/or agent for this job only. */
export async function startIssueAction(
  repoId: number,
  issueNumber: number,
  opts: { model?: string; agent?: string } = {},
) {
  const repo = getRepo(repoId);
  if (!repo) throw new Error(`repo ${repoId} not found`);
  const job = createJob({
    repoId,
    issueNumber,
    model: opts.model ?? repo.defaultModel,
    agent: opts.agent,
  });
  revalidatePath(`/repos/${repoId}`);
  return job;
}

/** Add the repo's queue label to an issue (GitHub + local cache). Optionally persist model/agent overrides for the driver to pick up. */
export async function addToQueueAction(
  repoId: number,
  issueNumber: number,
  opts: { model?: string; agent?: string } = {},
) {
  const result = await queueIssue(repoId, issueNumber, opts);
  revalidatePath(`/repos/${repoId}`);
  return result;
}

/** Remove the repo's queue label from an issue (GitHub + local cache). */
export async function removeFromQueueAction(repoId: number, issueNumber: number) {
  const result = await dequeueIssue(repoId, issueNumber);
  revalidatePath(`/repos/${repoId}`);
  return result;
}

/** Full issue detail incl. body and comments, fetched live from GitHub. */
export async function viewIssueAction(repoId: number, issueNumber: number) {
  const repo = getRepo(repoId);
  if (!repo) throw new Error(`repo ${repoId} not found`);
  return getForge(repo).viewIssue(issueNumber);
}

/** The tracked subtasks of a decomposed issue, in order (empty if none). */
export async function listSubtasksAction(repoId: number, issueNumber: number) {
  return listSubtasks(repoId, issueNumber);
}

/** Edit issue title and/or body. */
export async function editIssueAction(
  repoId: number,
  issueNumber: number,
  patch: { title?: string; body?: string },
) {
  const repo = getRepo(repoId);
  if (!repo) throw new Error(`repo ${repoId} not found`);
  await getForge(repo).editIssue(issueNumber, patch);
  revalidatePath(`/repos/${repoId}`);
}

/** Post a comment on an issue. */
export async function commentIssueAction(repoId: number, issueNumber: number, body: string) {
  const repo = getRepo(repoId);
  if (!repo) throw new Error(`repo ${repoId} not found`);
  await getForge(repo).commentIssue(issueNumber, body);
}

/** Add or remove labels on an issue (GitHub + local cache for the queue label). */
export async function setIssueLabelsAction(
  repoId: number,
  issueNumber: number,
  add: string[],
  remove: string[],
) {
  await applyIssueLabels(repoId, issueNumber, add, remove);
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
  const gh = getForge(repo);
  if (state === "closed") await gh.closeIssue(issueNumber);
  else await gh.reopenIssue(issueNumber);
  revalidatePath(`/repos/${repoId}`);
}
