import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AgentId, ProviderLimitInfo, ProviderLimitKind } from "@/lib/agents/types";
import { type DB, getDb } from "@/lib/db/client";
import { settings } from "@/lib/db/schema";
import { getSettings } from "@/lib/settings/service";

/**
 * Global, DB-persisted provider-limit latch (issues #166/#167, ADR 030). When
 * an agent session fails on an exhausted quota, the orchestrator latches that
 * provider: the driver stops claiming its jobs, the babysitter defers CI
 * fixes, and parked work resumes automatically once the window elapses. The
 * latch is keyed per agent, so a blocked Claude never stalls Codex work and
 * vice versa.
 *
 * The latch lives in the settings key-value table (its own key, not the
 * "global" settings blob) so it survives a process restart: a Drydock that
 * reboots mid-window must not immediately re-spend a spawn against a quota
 * it already knows is exhausted.
 */

/**
 * Thrown by one-shot paths (decomposition, issue #167) when the agent CLI
 * failed on a waitable provider limit: the caller aborts its sweep instead of
 * persisting the failure as a normal outcome, and retries after the latch.
 */
export class ProviderLimitError extends Error {
  constructor(readonly info: ProviderLimitInfo) {
    super(`${info.agent} ${info.kind}: ${info.rawSnippet}`);
    this.name = "ProviderLimitError";
  }
}

export interface ProviderLimitLatch {
  agent: string;
  kind: ProviderLimitKind;
  /** Epoch seconds of the first detection in the current streak. */
  since: number;
  /** Epoch seconds until which the provider is considered blocked. */
  blockedUntil: number;
  /** Consecutive limit detections without a successful run in between. */
  strikes: number;
  /** Redacted excerpt of the triggering CLI output. */
  rawSnippet: string;
}

const latchSchema = z.object({
  agent: z.string(),
  kind: z.enum(["usage_limit", "rate_limit", "overloaded", "auth", "billing"]),
  since: z.number(),
  blockedUntil: z.number(),
  strikes: z.number().int().positive(),
  rawSnippet: z.string(),
});

const keyFor = (agent: string) => `provider_limit:${agent}`;
const nowSec = () => Math.floor(Date.now() / 1000);

/** Never trust a parsed reset blindly: at least a beat, at most a day. */
const MIN_WAIT_SEC = 60;
const MAX_WAIT_SEC = 24 * 3600;

/** Fallback cooldowns when the CLI reported no reset time, doubled per strike. */
const BASE_COOLDOWN_SEC: Partial<Record<ProviderLimitKind, number>> = {
  usage_limit: 30 * 60,
  rate_limit: 5 * 60,
  overloaded: 2 * 60,
};
const MAX_COOLDOWN_SEC: Partial<Record<ProviderLimitKind, number>> = {
  usage_limit: 4 * 3600,
  rate_limit: 30 * 60,
  overloaded: 30 * 60,
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/** The persisted latch for `agent`, or undefined when absent/corrupt. */
export function getProviderLimitLatch(
  agent: string,
  db: DB = getDb(),
): ProviderLimitLatch | undefined {
  const row = db
    .select()
    .from(settings)
    .where(eq(settings.key, keyFor(agent)))
    .get();
  if (!row) return undefined;
  try {
    return latchSchema.parse(JSON.parse(row.value));
  } catch {
    return undefined;
  }
}

function saveLatch(latch: ProviderLimitLatch, db: DB): void {
  const key = keyFor(latch.agent);
  const value = JSON.stringify(latch);
  const existing = db.select().from(settings).where(eq(settings.key, key)).get();
  if (existing) {
    db.update(settings).set({ value }).where(eq(settings.key, key)).run();
  } else {
    db.insert(settings).values({ key, value }).run();
  }
}

/**
 * Record a fresh limit detection and compute the wait window. The CLI's own
 * reset time (or retry-after hint) wins when present, clamped to a sane range;
 * otherwise a per-kind cooldown doubles with each consecutive strike so a
 * window that keeps failing backs off instead of spinning. Returns whether
 * this detection *entered* the blocked state (for edge notifications).
 */
export function latchProviderLimit(
  info: ProviderLimitInfo,
  db: DB = getDb(),
  now: number = nowSec(),
): { latch: ProviderLimitLatch; entered: boolean } {
  const existing = getProviderLimitLatch(info.agent, db);
  const sameStreak = existing?.kind === info.kind;
  const strikes = sameStreak ? existing.strikes + 1 : 1;

  let blockedUntil: number;
  if (info.resetAt !== undefined) {
    blockedUntil = clamp(info.resetAt, now + MIN_WAIT_SEC, now + MAX_WAIT_SEC);
  } else if (info.retryAfterMs !== undefined) {
    blockedUntil = clamp(
      now + Math.ceil(info.retryAfterMs / 1000),
      now + MIN_WAIT_SEC,
      now + MAX_WAIT_SEC,
    );
  } else {
    const base = BASE_COOLDOWN_SEC[info.kind] ?? BASE_COOLDOWN_SEC.usage_limit ?? 1800;
    const cap = MAX_COOLDOWN_SEC[info.kind] ?? MAX_COOLDOWN_SEC.usage_limit ?? 4 * 3600;
    blockedUntil = now + Math.min(base * 2 ** (strikes - 1), cap);
  }

  const latch: ProviderLimitLatch = {
    agent: info.agent,
    kind: info.kind,
    since: sameStreak ? existing.since : now,
    blockedUntil,
    strikes,
    rawSnippet: info.rawSnippet,
  };
  saveLatch(latch, db);
  const wasBlocked = existing !== undefined && existing.blockedUntil > now;
  return { latch, entered: !wasBlocked };
}

/** The active latch for `agent`, or undefined once its window has elapsed. */
export function providerLimitBlocked(
  agent: string,
  db: DB = getDb(),
  now: number = nowSec(),
): ProviderLimitLatch | undefined {
  const latch = getProviderLimitLatch(agent, db);
  if (!latch || latch.blockedUntil <= now) return undefined;
  return latch;
}

/** Drop the latch entirely (a session succeeded — the streak is over). */
export function clearProviderLimit(agent: string, db: DB = getDb()): void {
  db.delete(settings)
    .where(eq(settings.key, keyFor(agent)))
    .run();
}

/**
 * Whether the operator's auto-wait toggle is on for `agent` (issues #166,
 * #167). With the toggle off Drydock behaves exactly as before the feature
 * for that agent: no claim gating, no parking, no deferral.
 */
export function limitAutoWaitEnabled(agent: AgentId, db: DB = getDb()): boolean {
  const settings = getSettings(db);
  if (agent === "codex") return settings.codexLimitAutoWait;
  return settings.claudeLimitAutoWait;
}

/** The active latch for `agent`, gated by its operator auto-wait toggle. */
export function agentLimitBlocked(
  agent: AgentId,
  db: DB = getDb(),
  now: number = nowSec(),
): ProviderLimitLatch | undefined {
  if (!limitAutoWaitEnabled(agent, db)) return undefined;
  return providerLimitBlocked(agent, db, now);
}
