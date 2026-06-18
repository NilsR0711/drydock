// Edge detection + gating for the live needs_human alert (issue #258). Kept
// free of DOM/audio so the logic that decides *whether* to alert is unit
// testable; the side effects (chime, toast, Web Notification) live in the
// dashboard component and the chime module.

/** A job parked in needs_human, named for an at-a-glance alert. */
export interface NeedsHumanJobRef {
  id: number;
  repoName: string;
  issueNumber: number;
}

/**
 * Jobs in `current` whose id is not in `prev` — the ones that just crossed the
 * edge into needs_human. Callers seed `prev` from the first snapshot so jobs
 * already parked when the tab connected (or reconnected) do not re-alert.
 */
export function newlyParkedJobs(
  prev: Iterable<number>,
  current: readonly NeedsHumanJobRef[],
): NeedsHumanJobRef[] {
  const seen = new Set(prev);
  return current.filter((job) => !seen.has(job.id));
}

/** Inputs that decide whether a backgrounded-tab desktop notification fires. */
export interface DesktopNotifyState {
  supported: boolean;
  permission: NotificationPermission;
  hidden: boolean;
}

/**
 * Only raise an OS-level Web Notification when the tab is backgrounded and the
 * user has already granted permission; the toast covers the foreground case,
 * and we never nag for permission the user did not grant.
 */
export function shouldNotifyDesktop({
  supported,
  permission,
  hidden,
}: DesktopNotifyState): boolean {
  return supported && permission === "granted" && hidden;
}
