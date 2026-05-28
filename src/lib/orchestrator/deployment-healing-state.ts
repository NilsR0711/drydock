/**
 * State machine for a single post-merge deployment-healing session (issue #20).
 * A session is bound to a merged PR + commit SHA and walks:
 *
 *   monitoring → healthy                              (deployment went live)
 *   monitoring → failed → repairing → repaired        (fix PR opened)
 *
 * From `monitoring` it may `escalate` on timeout (deployment never settled) and
 * from `failed`/`repairing` it may `escalate` if no fix PR could be opened.
 */
export const DEPLOYMENT_HEALING_STATES = [
  "monitoring",
  "failed",
  "repairing",
  "healthy",
  "repaired",
  "escalated",
] as const;

export type DeploymentHealingStatus = (typeof DEPLOYMENT_HEALING_STATES)[number];

export const DEPLOYMENT_HEALING_TERMINAL_STATES: readonly DeploymentHealingStatus[] = [
  "healthy",
  "repaired",
  "escalated",
];

const TRANSITIONS: Record<DeploymentHealingStatus, readonly DeploymentHealingStatus[]> = {
  monitoring: ["healthy", "failed", "escalated"],
  failed: ["repairing", "escalated"],
  repairing: ["repaired", "escalated"],
  healthy: [],
  repaired: [],
  escalated: [],
};

export function isDeploymentHealingStatus(s: string): s is DeploymentHealingStatus {
  return (DEPLOYMENT_HEALING_STATES as readonly string[]).includes(s);
}

export function isDeploymentHealingTerminal(s: DeploymentHealingStatus): boolean {
  return DEPLOYMENT_HEALING_TERMINAL_STATES.includes(s);
}

export function canDeploymentHealingTransition(
  from: DeploymentHealingStatus,
  to: DeploymentHealingStatus,
): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidDeploymentHealingTransitionError extends Error {
  constructor(from: DeploymentHealingStatus, to: DeploymentHealingStatus) {
    super(`invalid deployment-healing transition: ${from} -> ${to}`);
  }
}

export function assertDeploymentHealingTransition(
  from: DeploymentHealingStatus,
  to: DeploymentHealingStatus,
): void {
  if (!canDeploymentHealingTransition(from, to)) {
    throw new InvalidDeploymentHealingTransitionError(from, to);
  }
}
