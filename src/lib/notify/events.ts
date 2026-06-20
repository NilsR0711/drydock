/**
 * Lifecycle events users can subscribe to for external notifications (issue
 * #22). Kept dependency-free so both the settings schema and the notifier can
 * import it without a cycle.
 */
export const NOTIFICATION_EVENTS = [
  "needs_human",
  "job_failed",
  "pr_opened",
  "pr_merged",
  "release_published",
  "cost_limit",
  "claude_limit",
  "codex_limit",
  "auth_expired",
  "automation_paused",
] as const;

export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

/** Human-readable labels for the settings UI. */
export const NOTIFICATION_EVENT_LABELS: Record<NotificationEvent, string> = {
  needs_human: "Job needs human",
  job_failed: "Job aborted or failed",
  pr_opened: "Pull request opened",
  pr_merged: "Pull request merged",
  release_published: "Release published",
  cost_limit: "Daily cost limit reached",
  claude_limit: "Claude usage limit reached or cleared",
  codex_limit: "Codex usage limit reached or cleared",
  auth_expired: "Credentials expired or restored",
  automation_paused: "Automation paused or draining",
};
