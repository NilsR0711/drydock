/**
 * State machine for a single release run (issue #59). A run is created when a
 * release is detected (a merged PR or a manual trigger) and walks:
 *
 *   detected → evaluating → proposed → publishing → published
 *                       ↘ skipped   ↘ skipped              (no release warranted)
 *
 * Any active state may enter `error`; a failed run is retried by transitioning
 * `error → evaluating`. `published` and `skipped` are terminal; `error` is not
 * (so it can be retried). Preview (dry-run) computes a candidate without ever
 * creating a run, so it touches no state here.
 */
export const RELEASE_STATES = [
  "detected",
  "evaluating",
  "proposed",
  "publishing",
  "published",
  "skipped",
  "error",
] as const;

export type ReleaseStatus = (typeof RELEASE_STATES)[number];

export const RELEASE_TERMINAL_STATES: readonly ReleaseStatus[] = ["published", "skipped"];

const TRANSITIONS: Record<ReleaseStatus, readonly ReleaseStatus[]> = {
  detected: ["evaluating", "error"],
  evaluating: ["proposed", "skipped", "error"],
  proposed: ["publishing", "skipped", "error"],
  publishing: ["published", "error"],
  published: [],
  skipped: [],
  // A failed run is retried by re-evaluating from scratch.
  error: ["evaluating"],
};

export function isReleaseStatus(s: string): s is ReleaseStatus {
  return (RELEASE_STATES as readonly string[]).includes(s);
}

export function isReleaseTerminal(s: ReleaseStatus): boolean {
  return RELEASE_TERMINAL_STATES.includes(s);
}

export function canReleaseTransition(from: ReleaseStatus, to: ReleaseStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidReleaseTransitionError extends Error {
  constructor(from: ReleaseStatus, to: ReleaseStatus) {
    super(`invalid release transition: ${from} -> ${to}`);
  }
}

export function assertReleaseTransition(from: ReleaseStatus, to: ReleaseStatus): void {
  if (!canReleaseTransition(from, to)) {
    throw new InvalidReleaseTransitionError(from, to);
  }
}
