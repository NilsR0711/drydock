import { type DB, getDb } from "@/lib/db/client";
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

const CLAUDE_LIMIT_MESSAGE =
  "⏳ Claude usage limit reached — Claude jobs are parked until the quota resets.";
const CLAUDE_LIMIT_CLEARED_MESSAGE = "▶️ Claude quota available again — parked jobs are resuming.";

/**
 * Two-sided edge notification for the Claude usage-limit latch (issue #166):
 * one message when the latch first blocks, one when it clears and parked work
 * resumes. Re-arms after each clear like the cost-limit edge.
 */
export async function notifyClaudeLimitEdge(
  blocked: boolean,
  state: EdgeState,
  db: DB = getDb(),
  transports: NotifyTransports = defaultTransports,
): Promise<void> {
  if (blocked) {
    if (state.active) return;
    state.active = true;
    await dispatch("claude_limit", CLAUDE_LIMIT_MESSAGE, db, transports);
  } else {
    if (!state.active) return;
    state.active = false;
    await dispatch("claude_limit", CLAUDE_LIMIT_CLEARED_MESSAGE, db, transports);
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
