import type { AgentId } from "@/lib/agents/types";
import { type DB, getDb } from "@/lib/db/client";
import type { CredentialFailure } from "@/lib/orchestrator/credential-status";
import type { NotificationEvent } from "./events";
import { defaultTransports, dispatch, type NotifyTransports } from "./notifier";

/**
 * Move the edge latch to `next`, then dispatch. The latch flips *before* the
 * await so an overlapping tick (these helpers run fire-and-forget) can't fire a
 * duplicate while the first dispatch is in flight. If the dispatch rejects —
 * e.g. a transient `SQLITE_BUSY` from the settings read inside {@link dispatch}
 * — the latch is rolled back to `prev` so the transition is retried on the next
 * tick instead of being latched away, and the error is re-thrown so the
 * caller's `.catch` can log it (issue #420).
 */
async function latchAndDispatch(
  state: EdgeState,
  next: boolean,
  event: NotificationEvent,
  text: string,
  db: DB,
  transports: NotifyTransports,
): Promise<void> {
  const prev = state.active;
  state.active = next;
  try {
    await dispatch(event, text, db, transports);
  } catch (err) {
    state.active = prev;
    throw err;
  }
}

/**
 * Edge-triggered notifications for orchestrator-level state (issue #22). These
 * states are polled on every driver tick, so naive dispatching would spam the
 * channels. The helpers fire only on the transition into the notable state and
 * re-arm once it clears.
 */

// Neutral wording so it fits both the daily and the monthly budget gate (issue
// #413), which share the same `cost_limit` reason and edge notification.
const COST_LIMIT_MESSAGE = "💸 Cost limit reached — new jobs are paused until the budget resets.";
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
    await latchAndDispatch(state, true, "cost_limit", COST_LIMIT_MESSAGE, db, transports);
  } else {
    state.active = false;
  }
}

/**
 * Per-agent enter/clear messages and event for the provider-limit edge. Keyed by
 * a subset of {@link AgentId}: only agents with usage-limit detection
 * (`classifyFailure`) ever latch. opencode (issue #349) has no limit detection,
 * so it never participates — adding a dead entry with no `*_limit` event would be
 * misleading. The `Partial<Record<…>>` constraint still validates every key is a
 * real agent and every value the right shape.
 */
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
} as const satisfies Partial<
  Record<AgentId, { event: NotificationEvent; blocked: string; cleared: string }>
>;

/** Agents that have usage-limit detection and can therefore latch (issues #166/#167). */
export type LimitAgentId = keyof typeof PROVIDER_LIMIT_MESSAGES;

/** The limit-capable agent ids, for callers that iterate the provider-limit latches. */
export const LIMIT_AGENT_IDS = Object.keys(PROVIDER_LIMIT_MESSAGES) as LimitAgentId[];

/**
 * Two-sided edge notification for an agent's usage-limit latch (issues
 * #166/#167): one message when the latch first blocks, one when it clears and
 * parked work resumes. Re-arms after each clear like the cost-limit edge.
 */
export async function notifyProviderLimitEdge(
  agent: LimitAgentId,
  blocked: boolean,
  state: EdgeState,
  db: DB = getDb(),
  transports: NotifyTransports = defaultTransports,
): Promise<void> {
  const messages = PROVIDER_LIMIT_MESSAGES[agent];
  if (blocked) {
    if (state.active) return;
    await latchAndDispatch(state, true, messages.event, messages.blocked, db, transports);
  } else {
    if (!state.active) return;
    await latchAndDispatch(state, false, messages.event, messages.cleared, db, transports);
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
    const targets = failures.map((f) => `${f.label}: ${f.message}`).join("; ");
    await latchAndDispatch(
      state,
      true,
      "auth_expired",
      `🔑 Credential check failed — new jobs are paused until auth is restored. ${targets}`,
      db,
      transports,
    );
  } else {
    if (!state.active) return;
    await latchAndDispatch(
      state,
      false,
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
