import { type AgentProvider, WAITABLE_LIMIT_KINDS } from "@/lib/agents/types";
import { type DB, getDb } from "@/lib/db/client";
import type { CommandRunner } from "@/lib/exec/runner";
import { logError } from "@/lib/log/logger";
import { type OneShotResult, type OneShotType, runOneShotAndRecordCost } from "./one-shot-runner";
import { latchProviderLimit, limitAutoWaitEnabled, ProviderLimitError } from "./provider-limit";

/**
 * The one place the run → classify → latch → parse path for a one-shot agent
 * call lives (issue #430). Five orchestrator drivers — post-PR verification, PR
 * question answering, release evaluation, PR audit, and issue decomposition —
 * each hand-rolled the same wrapper around {@link runOneShotAndRecordCost}, and
 * three of them had silently dropped the provider-limit latch (issues
 * #166/#167). This factory implements the wrapper once so every driver latches
 * identically and future fixes to the path apply everywhere at once.
 */

/**
 * Apply the provider-limit decision to a finished, non-zero one-shot (issues
 * #166/#167). When the failure classifies as a waitable limit and the operator's
 * auto-wait toggle is on for the agent, latch the provider globally and throw
 * {@link ProviderLimitError} so the caller defers instead of persisting the
 * failure as a normal outcome. Any other failure (or auto-wait off) is a no-op:
 * the caller handles the non-zero exit as a plain failure.
 */
export function latchWaitableProviderLimit(
  deps: { provider: AgentProvider; db?: DB },
  res: { exitCode: number; stderr: string; text: string },
): void {
  const limit = deps.provider.classifyFailure?.({
    exitCode: res.exitCode,
    stderr: res.stderr,
    resultText: res.text,
  });
  if (limit && WAITABLE_LIMIT_KINDS.includes(limit.kind)) {
    const db = deps.db ?? getDb();
    if (limitAutoWaitEnabled(deps.provider.id, db)) {
      latchProviderLimit(limit, db);
      throw new ProviderLimitError(limit);
    }
  }
}

/** The invocation shape every one-shot generator shares (issue #430). */
export interface OneShotGeneratorDeps {
  provider: AgentProvider;
  command: string;
  model: string;
  cwd: string;
  /** When omitted, cost is tracked in memory only (no DB row). */
  repoId?: number;
  db?: DB;
  runner?: CommandRunner;
  /** Overrides {@link OneShotGeneratorSpec.defaultTimeoutMs} when set. */
  timeoutMs?: number;
}

/**
 * How one specific one-shot maps agent output onto its own result type. Exactly
 * one of the three callbacks runs per invocation: `onResult` on a clean (zero)
 * exit, `onExit` on a non-zero exit that was not a latched provider limit, and
 * `onError` when the one-shot call itself threw (a timeout or spawn error). A
 * {@link ProviderLimitError} raised by the latch is never routed to `onError` —
 * it always propagates so the caller can defer.
 */
export interface OneShotGeneratorSpec<TInput, TResult> {
  type: OneShotType;
  /** Applied when `deps.timeoutMs` is unset; omit for no wall-clock bound. */
  defaultTimeoutMs?: number;
  buildPrompt: (input: TInput) => string;
  onResult: (text: string, input: TInput) => TResult;
  onExit: (info: { exitCode: number; stderr: string; text: string }, input: TInput) => TResult;
  onError: (err: unknown, input: TInput) => TResult;
}

/**
 * Build a one-shot agent generator around the shared run/classify/latch/parse
 * path (issue #430). Callers supply their prompt builder and result mapping; the
 * cost recording, provider-limit latch, and timeout handling come from here.
 */
export function buildOneShotGenerator<TInput, TResult>(
  deps: OneShotGeneratorDeps,
  spec: OneShotGeneratorSpec<TInput, TResult>,
): (input: TInput) => Promise<TResult> {
  const timeoutMs = deps.timeoutMs ?? spec.defaultTimeoutMs;
  return async (input) => {
    let res: OneShotResult;
    try {
      res = await runOneShotAndRecordCost({
        provider: deps.provider,
        command: deps.command,
        model: deps.model,
        cwd: deps.cwd,
        prompt: spec.buildPrompt(input),
        repoId: deps.repoId,
        type: spec.type,
        timeoutMs,
        runner: deps.runner,
        db: deps.db,
      });
    } catch (err) {
      return spec.onError(err, input);
    }
    if (res.exitCode !== 0) {
      // Latch and throw on a waitable limit — this propagates past onExit so the
      // caller defers; otherwise fall through to the plain-failure mapping.
      latchWaitableProviderLimit(deps, res);
      return spec.onExit({ exitCode: res.exitCode, stderr: res.stderr, text: res.text }, input);
    }
    return spec.onResult(res.text, input);
  };
}

/**
 * Run an async best-effort read, returning `fallback` on any failure. The
 * failure is logged under `label` so a degraded context (empty diff, missing
 * issue body) is diagnosable rather than silent — the single logging variant of
 * the helper the PR-audit and PR-question drivers used to each copy (issue #430).
 */
export async function safe<T>(fn: () => Promise<T>, fallback: T, label = "one-shot"): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    logError(`[${label}] best-effort read failed, using fallback`, err);
    return fallback;
  }
}
