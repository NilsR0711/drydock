/**
 * State machine for a single tracked subtask of a decomposed issue (issue #19).
 * A large issue is split into ordered subtasks, each of which walks:
 *
 *   pending → in_progress → done
 *
 * `pending` is a freshly decomposed subtask awaiting its turn. It moves to
 * `in_progress` while the agent works it, then `done` once that work lands. A
 * subtask the agent (or a human) decides not to do is `skipped`; one postponed
 * for a later pass is `deferred` and can return to `pending`/`in_progress`.
 * `done` and `skipped` are terminal.
 */
export const SUBTASK_STATES = ["pending", "in_progress", "done", "skipped", "deferred"] as const;

export type SubtaskStatus = (typeof SUBTASK_STATES)[number];

export const SUBTASK_TERMINAL_STATES: readonly SubtaskStatus[] = ["done", "skipped"];

const TRANSITIONS: Record<SubtaskStatus, readonly SubtaskStatus[]> = {
  pending: ["in_progress", "skipped", "deferred"],
  in_progress: ["done", "skipped", "deferred"],
  deferred: ["pending", "in_progress", "skipped"],
  done: [],
  skipped: [],
};

export function isSubtaskStatus(s: string): s is SubtaskStatus {
  return (SUBTASK_STATES as readonly string[]).includes(s);
}

export function canSubtaskTransition(from: SubtaskStatus, to: SubtaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidSubtaskTransitionError extends Error {
  constructor(from: SubtaskStatus, to: SubtaskStatus) {
    super(`invalid subtask transition: ${from} -> ${to}`);
  }
}

export function assertSubtaskTransition(from: SubtaskStatus, to: SubtaskStatus): void {
  if (!canSubtaskTransition(from, to)) throw new InvalidSubtaskTransitionError(from, to);
}
