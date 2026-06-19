export const JOB_STATES = [
  "queued",
  "working",
  "ci_running",
  "ci_failed",
  "retrying",
  "waiting_limit",
  "merged",
  // Terminal success of an agent-driven release job (issue #256). A release has
  // no PR/CI, so it is its own terminal state rather than reusing `merged`
  // (which would weaken the issue-job invariant that merged is only reachable
  // via ci_running, and would pollute PR-merge analytics).
  "released",
  "needs_human",
  "aborted",
  "interrupted",
] as const;

export type JobStatus = (typeof JOB_STATES)[number];

/** Allowed forward transitions per SPEC §3. Terminal states have no successors. */
const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  queued: ["working", "aborted", "interrupted"],
  // `released` is the agent-release terminal success (issue #256); reachable
  // only from working because a release job never opens a PR or runs CI.
  working: ["ci_running", "waiting_limit", "released", "needs_human", "aborted", "interrupted"],
  ci_running: ["ci_failed", "merged", "needs_human", "aborted", "interrupted"],
  ci_failed: ["retrying", "needs_human", "aborted", "interrupted"],
  retrying: ["ci_running", "needs_human", "aborted", "interrupted"],
  // Parked on an exhausted provider quota (issue #166, ADR 030): the driver
  // requeues it automatically once the limit window clears; an operator may
  // still requeue or abort it by hand.
  waiting_limit: ["queued", "needs_human", "aborted", "interrupted"],
  merged: [],
  released: [],
  needs_human: ["queued", "aborted"],
  aborted: [],
  interrupted: ["queued", "aborted"],
};

export const TERMINAL_STATES: readonly JobStatus[] = ["merged", "released", "aborted"];

/**
 * Terminal *success* states: the issue's work landed — a PR merged, or an
 * agent-driven release published (issue #256). Distinct from the terminal
 * failure state `aborted`, these mark an issue as done. Re-enqueuing such an
 * issue would redo already-merged work, so issue-level dedupe consults this to
 * block a stale fetched snapshot from reworking a just-merged issue (issue #288).
 */
export const TERMINAL_SUCCESS_STATES: readonly JobStatus[] = ["merged", "released"];

/**
 * Every non-terminal state — the set the driver loop uses for issue-level
 * dedupe (an issue with such a job is already scheduled/running and must not be
 * enqueued again) and the Issues board uses to decide what counts as "in the
 * queue", regardless of how it got there (manual queue label vs. auto `ready`
 * path, issue #286). Derived from JOB_STATES so it stays in lockstep with the
 * state machine. Includes the parked states (needs_human/interrupted): work
 * exists for those issues even though it waits on an operator.
 */
export const OPEN_STATES: readonly JobStatus[] = JOB_STATES.filter(
  (s) => !TERMINAL_STATES.includes(s),
);

export function isJobStatus(s: string): s is JobStatus {
  return (JOB_STATES as readonly string[]).includes(s);
}

/** True when `s` is a non-terminal job state (see {@link OPEN_STATES}). */
export function isOpenStatus(s: JobStatus): boolean {
  return OPEN_STATES.includes(s);
}

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(from: JobStatus, to: JobStatus) {
    super(`invalid job transition: ${from} -> ${to}`);
  }
}

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}
