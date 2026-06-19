"use server";

import { revalidatePath } from "next/cache";
import { isAgentId } from "@/lib/agents/registry";
import { getRepo } from "@/lib/db/queries";
import { getForge } from "@/lib/forge/registry";
import {
  applyIssueLabels,
  bulkApplyLabel,
  bulkDequeueIssues,
  bulkQueueIssues,
  dequeueIssue,
  queueIssue,
  reorderIssues,
  syncRepoIssues,
} from "@/lib/issues/service";
import { listSubtasks } from "@/lib/issues/subtasks";
import { isKnownModelId } from "@/lib/models";
import { openJobForIssue, openJobsByIssue, transitionJob } from "@/lib/orchestrator/jobs";
import { enqueueJob } from "@/lib/orchestrator/queue";
import { canTransition, type JobStatus } from "@/lib/orchestrator/state-machine";

/** Fetch all open issues from GitHub and cache them (backlog + queue). */
export async function syncRepoIssuesAction(repoId: number) {
  const result = await syncRepoIssues(repoId);
  revalidatePath(`/repos/${repoId}`);
  return result;
}

/**
 * Map of issueNumber → open (non-terminal) job status for the repo (issue #286).
 * The Issues board polls this so the Queue/Backlog split reflects actual
 * scheduler state, not just the queue label. Local DB read — no GitHub round-trip.
 */
export async function listOpenIssueJobsAction(repoId: number): Promise<Record<number, JobStatus>> {
  return openJobsByIssue(repoId);
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
  if (opts.model !== undefined && !isKnownModelId(opts.model)) {
    throw new Error(`unknown model id: ${opts.model}`);
  }
  if (opts.agent !== undefined && !isAgentId(opts.agent)) {
    throw new Error(`unknown agent: ${opts.agent}`);
  }
  // Same dedupe-guarded path as the driver loop (issue #23): a manual start
  // must not create a second live job for an issue — a double click, or
  // starting an issue the scheduler already enqueued, would otherwise spawn
  // two competing worktrees/PRs for the same issue.
  const job = enqueueJob({
    repoId,
    issueNumber,
    model: opts.model ?? repo.defaultModel,
    agent: opts.agent ?? repo.agent,
  });
  if (!job) {
    throw new Error(`A job for issue #${issueNumber} is already active.`);
  }
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

/**
 * Since #286 an open job keeps an issue pinned in the Queue zone regardless of
 * the queue label, so removing only the label leaves the issue stuck up top.
 * When dequeuing, also abort a job that has NOT started yet (`queued`) so the
 * issue actually drops to the backlog. A `working` job (or any later state) is
 * left untouched — it is real in-flight work, not a stale queue entry (#311).
 */
function abortQueuedJobForIssue(repoId: number, issueNumber: number) {
  const job = openJobForIssue(repoId, issueNumber);
  if (job?.status === "queued" && canTransition("queued", "aborted")) {
    transitionJob(job.id, "aborted");
  }
}

/** Remove the repo's queue label from an issue (GitHub + local cache). */
export async function removeFromQueueAction(repoId: number, issueNumber: number) {
  const result = await dequeueIssue(repoId, issueNumber);
  abortQueuedJobForIssue(repoId, issueNumber);
  revalidatePath(`/repos/${repoId}`);
  return result;
}

/** Add the queue label to several issues at once (issue #111). Returns issues. */
export async function bulkAddToQueueAction(repoId: number, issueNumbers: number[]) {
  const result = await bulkQueueIssues(repoId, issueNumbers);
  revalidatePath(`/repos/${repoId}`);
  return result;
}

/** Remove the queue label from several issues at once (issue #111). Returns issues. */
export async function bulkRemoveFromQueueAction(repoId: number, issueNumbers: number[]) {
  const result = await bulkDequeueIssues(repoId, issueNumbers);
  for (const number of issueNumbers) abortQueuedJobForIssue(repoId, number);
  revalidatePath(`/repos/${repoId}`);
  return result;
}

/** Apply one label across several issues at once (issue #111). Returns issues. */
export async function bulkApplyLabelAction(repoId: number, issueNumbers: number[], label: string) {
  const result = await bulkApplyLabel(repoId, issueNumbers, label);
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
