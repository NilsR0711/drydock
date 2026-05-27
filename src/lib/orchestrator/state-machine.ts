export const JOB_STATES = [
  "queued",
  "working",
  "ci_running",
  "ci_failed",
  "retrying",
  "merged",
  "needs_human",
  "aborted",
  "interrupted",
] as const;

export type JobStatus = (typeof JOB_STATES)[number];

/** Allowed forward transitions per SPEC §3. Terminal states have no successors. */
const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  queued: ["working", "aborted", "interrupted"],
  working: ["ci_running", "needs_human", "aborted", "interrupted"],
  ci_running: ["ci_failed", "merged", "needs_human", "aborted", "interrupted"],
  ci_failed: ["retrying", "needs_human", "aborted", "interrupted"],
  retrying: ["ci_running", "needs_human", "aborted", "interrupted"],
  merged: [],
  needs_human: ["queued", "aborted"],
  aborted: [],
  interrupted: ["queued", "aborted"],
};

export const TERMINAL_STATES: readonly JobStatus[] = ["merged", "aborted"];

export function isJobStatus(s: string): s is JobStatus {
  return (JOB_STATES as readonly string[]).includes(s);
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
