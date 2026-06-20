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
 * Operationally live states: the job is actively progressing, or will resume on
 * its own, so it stays stoppable from the UI. `waiting_limit` is included — the
 * driver requeues it once the provider quota clears (issue #166) — so the detail
 * page keeps the Stop button and runs the live metrics/log streams while parked
 * there (issues #242, #337).
 */
export const IN_FLIGHT_STATES: readonly JobStatus[] = [
  "working",
  "ci_running",
  "retrying",
  "waiting_limit",
];

/** True when `s` is an in-flight state (see {@link IN_FLIGHT_STATES}). */
export function isInFlight(s: string): boolean {
  return (IN_FLIGHT_STATES as readonly string[]).includes(s);
}

/**
 * States whose entry stamps the job's `finishedAt`: the run is over — merged,
 * released, parked for a human, or aborted. The detail page's duration timer
 * freezes when a transition into one of these arrives live (issue #337), so this
 * MUST stay in lockstep with the `finishedAt` write in `transitionJob`.
 * `interrupted` is excluded: it parks the job for automatic recovery and leaves
 * `finishedAt` unset.
 */
export const FINISHED_STATES: readonly JobStatus[] = [
  "merged",
  "released",
  "needs_human",
  "aborted",
];

/** True when entering `s` stamps `finishedAt` (see {@link FINISHED_STATES}). */
export function isFinishedState(s: string): boolean {
  return (FINISHED_STATES as readonly string[]).includes(s);
}

/**
 * States whose per-job SSE stream produces no further events once entered — the
 * terminal states plus the parked states a job sits in until an operator acts.
 * The log viewer and the live header close their EventSource on reaching one,
 * rather than holding a connection open forever (issues #241, #337).
 */
export const STREAM_END_STATES: readonly JobStatus[] = [
  "merged",
  "released",
  "needs_human",
  "aborted",
  "interrupted",
];

/** True when `s` ends the per-job SSE stream (see {@link STREAM_END_STATES}). */
export function isStreamEndState(s: string): boolean {
  return (STREAM_END_STATES as readonly string[]).includes(s);
}

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
