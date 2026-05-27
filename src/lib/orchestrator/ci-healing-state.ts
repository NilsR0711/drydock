/**
 * State machine for a single CI auto-heal session (issue #16). A session is
 * bound to a PR + head SHA and walks:
 *
 *   triaging → awaiting_slot → repairing → awaiting_ci → verifying → healed
 *
 * If a verified attempt left checks still red it loops back through `cooldown`
 * (enforcing the inter-attempt wait) to `awaiting_slot` for another try. Any
 * active state may end in `blocked` (external failure), `escalated` (budget
 * exhausted / no real change) or `superseded` (the PR head moved on).
 */
export const HEALING_STATES = [
  "triaging",
  "awaiting_slot",
  "repairing",
  "awaiting_ci",
  "verifying",
  "cooldown",
  "healed",
  "blocked",
  "escalated",
  "superseded",
] as const;

export type HealingStatus = (typeof HEALING_STATES)[number];

export const HEALING_TERMINAL_STATES: readonly HealingStatus[] = [
  "healed",
  "blocked",
  "escalated",
  "superseded",
];

const EXITS: readonly HealingStatus[] = ["blocked", "escalated", "superseded"];

const TRANSITIONS: Record<HealingStatus, readonly HealingStatus[]> = {
  triaging: ["awaiting_slot", ...EXITS],
  awaiting_slot: ["repairing", ...EXITS],
  repairing: ["awaiting_ci", ...EXITS],
  awaiting_ci: ["verifying", ...EXITS],
  verifying: ["healed", "cooldown", ...EXITS],
  cooldown: ["awaiting_slot", ...EXITS],
  healed: [],
  blocked: [],
  escalated: [],
  superseded: [],
};

export function isHealingStatus(s: string): s is HealingStatus {
  return (HEALING_STATES as readonly string[]).includes(s);
}

export function canHealingTransition(from: HealingStatus, to: HealingStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidHealingTransitionError extends Error {
  constructor(from: HealingStatus, to: HealingStatus) {
    super(`invalid healing transition: ${from} -> ${to}`);
  }
}

export function assertHealingTransition(from: HealingStatus, to: HealingStatus): void {
  if (!canHealingTransition(from, to)) throw new InvalidHealingTransitionError(from, to);
}
