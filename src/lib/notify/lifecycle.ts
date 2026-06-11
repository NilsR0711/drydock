import type { AgentId } from "@/lib/agents/types";
import { type DB, getDb } from "@/lib/db/client";
import type { CredentialFailure } from "@/lib/orchestrator/credential-status";
import type { NotificationEvent } from "./events";
import { defaultTransports, dispatch, type NotifyTransports } from "./notifier";

/**
 * Edge-triggered notifications for orchestrator-level state (issue #22). These
 * states are polled on every driver tick, so naive dispatching would spam the
 * channels. The helpers fire only on the transition into the notable state and
 * re-arm once it clears.
 */

const COST_LIMIT_MESSAGE =
  "💸 Daily cost limit reached — new jobs are paused until the budget resets.";
const PAUSED_MESSAGE = "⏸️ Automation paused — no new jobs will start until it resumes.";
const DRAINING_MESSAGE = "🌙 Automation draining — finishing in-flight jobs, then shutting down.";

/** Latch tracking whether a one-shot edge notification has already fired. */
export interface EdgeState {
  active: boolean;
}

/**
 * Notify on the first poll where `blocked` is true, then suppress repeats until
 * the limit clears. Caller owns the {@link EdgeState} so the latch survives
 * across ticks.
 */
export async function notifyCostLimitEdge(
  blocked: boolean,
  state: EdgeState,
  db: DB = getDb(),
  transports: NotifyTransports = defaultTransports,
): Promise<void> {
  if (blocked) {
    if (state.active) return;
    state.active = true;
    await dispatch("cost_limit", COST_LIMIT_MESSAGE, db, transports);
  } else {
    state.active = false;
  }
}

/** Per-agent enter/clear messages and event for the provider-limit edge. */
const PROVIDER_LIMIT_MESSAGES = {
  claude: {
    event: "claude_limit",
    blocked: "⏳ Claude usage limit reached — Claude jobs are parked until the quota resets.",
    cleared: "▶️ Claude quota available again — parked jobs are resuming.",
  },
  codex: {
    event: "codex_limit",
    blocked: "⏳ Codex usage limit reached — Codex jobs are parked until the quota resets.",
    cleared: "▶️ Codex capacity available again — parked jobs are resuming.",
  },
  openrouter: {
    event: "openrouter_limit",
    blocked: "⏳ OpenRouter limit reached — OpenRouter jobs are parked until the window resets.",
    cleared: "▶️ OpenRouter available again — parked jobs are resuming.",
  },
} as const satisfies Record<
  AgentId,
  { event: NotificationEvent; blocked: string; cleared: string }
>;

/**
 * Two-sided edge notification for an agent's usage-limit latch (issues
 * #166/#167): one message when the latch first blocks, one when it clears and
 * parked work resumes. Re-arms after each clear like the cost-limit edge.
 */
export async function notifyProviderLimitEdge(
  agent: AgentId,
  blocked: boolean,
  state: EdgeState,
  db: DB = getDb(),
  transports: NotifyTransports = defaultTransports,
): Promise<void> {
  const messages = PROVIDER_LIMIT_MESSAGES[agent];
  if (blocked) {
    if (state.active) return;
    state.active = true;
    await dispatch(messages.event, messages.blocked, db, transports);
  } else {
    if (!state.active) return;
    state.active = false;
    await dispatch(messages.event, messages.cleared, db, transports);
  }
}

/**
 * Two-sided edge notification for the credential watchdog (issue #177): one
 * message when a probe round first finds dead credentials (naming each failing
 * target so the operator knows what to fix), one when a later round finds
 * everything healthy again and the queue resumes. Re-arms after each recovery.
 */
export async function notifyCredentialEdge(
  failures: readonly CredentialFailure[],
  state: EdgeState,
  db: DB = getDb(),
  transports: NotifyTransports = defaultTransports,
): Promise<void> {
  if (failures.length > 0) {
    if (state.active) return;
    state.active = true;
    const targets = failures.map((f) => `${f.label}: ${f.message}`).join("; ");
    await dispatch(
      "auth_expired",
      `🔑 Credential check failed — new jobs are paused until auth is restored. ${targets}`,
      db,
      transports,
    );
  } else {
    if (!state.active) return;
    state.active = false;
    await dispatch(
      "auth_expired",
      "🔑 Credentials restored — the queue is resuming.",
      db,
      transports,
    );
  }
}

/** Notify only when pause flips from off to on (a settings change). */
export async function notifyPauseTransition(
  before: boolean,
  after: boolean,
  db: DB = getDb(),
  transports: NotifyTransports = defaultTransports,
): Promise<void> {
  if (!before && after) {
    await dispatch("automation_paused", PAUSED_MESSAGE, db, transports);
  }
}

/** Notify that the orchestrator has entered graceful-shutdown drain mode. */
export async function notifyDraining(
  db: DB = getDb(),
  transports: NotifyTransports = defaultTransports,
): Promise<void> {
  await dispatch("automation_paused", DRAINING_MESSAGE, db, transports);
}
