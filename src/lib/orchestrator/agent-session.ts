import { eq, sql } from "drizzle-orm";
import { getAgentProvider } from "@/lib/agents/registry";
import type { AgentProvider } from "@/lib/agents/types";
import { type DB, getDb } from "@/lib/db/client";
import type { Job } from "@/lib/db/schema";
import { jobs } from "@/lib/db/schema";
import { type StreamHandle, type StreamRunner, spawnStreamRunner } from "@/lib/exec/stream-runner";
import { TEMPLATE_NAMES } from "@/lib/prompts/defaults";
import { renderTemplate, resolveTemplateContent } from "@/lib/prompts/templates";
import { getBroker, type LogBroker } from "@/lib/stream/broker";
import { transitionJob } from "./jobs";
import { clearAbort, registerAbort } from "./singleton";

export interface AgentSessionDeps {
  runner?: StreamRunner;
  db?: DB;
  broker?: LogBroker;
  /** Override the provider; defaults to the agent recorded on the job. */
  provider?: AgentProvider;
  /** Override the CLI binary/path; defaults to the provider's default command. */
  command?: string;
  /**
   * Hard wall-clock timeout for the session in ms (issue #47). On breach the
   * subprocess is aborted (SIGTERM → SIGKILL) and the result is flagged
   * `timedOut`. Omitted or non-positive means no bound (used in fast tests).
   */
  timeoutMs?: number;
  /**
   * Per-job USD cost ceiling (issue #57). As the stream accumulates cost, the
   * session is priced live (the agent's reported cost if any, else the token
   * estimate); the first time it reaches this cap the subprocess is aborted
   * (SIGTERM → SIGKILL) and the result is flagged `costExceeded`. Omitted or
   * non-positive disables the ceiling.
   */
  costCapUsd?: number;
  /**
   * Drain timeout in ms after force-abort before finalising cost/log (issue #97).
   * Defaults to 5000 (same as the SIGKILL grace period). Set to a low value in
   * tests to avoid slow test runs when using hanging runners.
   */
  graceMs?: number;
  /**
   * Run this as an out-of-band side session (review feedback, deployment fix)
   * rather than the job's main lifecycle run: the job state is left untouched
   * (the forced `working` transition would throw for jobs past `working`, e.g.
   * `ci_running` or `merged`), the recorded main session id is preserved so CI
   * fixes can still resume it, and usage accumulates additively instead of
   * replacing the main session's numbers.
   */
  sideSession?: boolean;
}

export interface AgentSessionResult {
  exitCode: number;
  sessionId?: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** True when the session was aborted by the wall-clock timeout (issue #47). */
  timedOut: boolean;
  /** True when the session was aborted by the per-job cost ceiling (issue #57). */
  costExceeded: boolean;
  /**
   * Set when the child process failed to spawn (e.g. ENOENT — CLI not found).
   * Distinguishes "binary missing" from a real non-zero agent exit so callers
   * can surface a clear "failed to start <command>" diagnostic.
   */
  spawnError?: Error;
}

/** Sentinel exit code recorded when a session is killed by the wall-clock timeout. */
const TIMED_OUT_EXIT = -1;
/** Sentinel exit code recorded when a session is killed by the per-job cost cap. */
const COST_EXCEEDED_EXIT = -2;

interface CostGuard {
  /** Re-price the accumulated usage; resolves `tripped` once the cap is crossed. */
  observe(): void;
  /** Resolves the first time the live cost reaches the cap. */
  readonly tripped: Promise<void>;
}

/**
 * Live per-job cost ceiling (issue #57). After each parsed chunk the session
 * calls {@link CostGuard.observe}, which prices the accumulated usage via
 * `liveCost` and resolves `tripped` the first time it reaches `capUsd`. The
 * caller is expected to construct the guard only when the cap is active
 * (positive), so `tripped` resolving always means a genuine breach.
 */
function makeCostGuard(capUsd: number, liveCost: () => number): CostGuard {
  let fire: () => void = () => {};
  let fired = false;
  const tripped = new Promise<void>((resolve) => {
    fire = resolve;
  });
  return {
    tripped,
    observe() {
      if (fired) return;
      if (liveCost() >= capUsd) {
        fired = true;
        fire();
      }
    },
  };
}

/**
 * Await a stream handle's exit, bounded by a wall-clock timeout (issue #47) and
 * a per-job cost ceiling (issue #57). On either breach the subprocess is
 * aborted and the outcome flagged accordingly. After aborting we drain the
 * child for up to `graceMs` milliseconds so that any stdout emitted during the
 * grace window is counted in the persisted cost (issue #97).
 */
function awaitBounded(
  handle: StreamHandle,
  opts: { timeoutMs?: number; costTripped?: Promise<void>; graceMs?: number } = {},
): Promise<{ exitCode: number; timedOut: boolean; costExceeded: boolean }> {
  const { timeoutMs, costTripped } = opts;
  const graceMs = opts.graceMs ?? 5000;
  const hasTimeout = !!timeoutMs && timeoutMs > 0;
  if (!hasTimeout && !costTripped) {
    return handle.done.then((exitCode) => ({ exitCode, timedOut: false, costExceeded: false }));
  }
  return new Promise((resolve) => {
    let settled = false;
    let aborting = false;
    const finish = (r: { exitCode: number; timedOut: boolean; costExceeded: boolean }) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    // After force-aborting, wait for the child to actually exit (or for the
    // grace timeout to expire) so that any stdout emitted during the grace
    // window flows through onStdout → parser before we finalise cost (issue #97).
    const abortAndDrain = (r: { exitCode: number; timedOut: boolean; costExceeded: boolean }) => {
      if (aborting) return;
      aborting = true;
      if (timer) clearTimeout(timer);
      handle.abort();
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const graceTimeout = new Promise<void>((res) => {
        graceTimer = setTimeout(res, graceMs);
        graceTimer.unref?.();
      });
      void Promise.race([handle.done, graceTimeout]).then(() => {
        clearTimeout(graceTimer);
        finish(r);
      });
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (hasTimeout) {
      timer = setTimeout(() => {
        abortAndDrain({ exitCode: TIMED_OUT_EXIT, timedOut: true, costExceeded: false });
      }, timeoutMs);
      timer.unref?.();
    }
    costTripped?.then(() => {
      abortAndDrain({ exitCode: COST_EXCEEDED_EXIT, timedOut: false, costExceeded: true });
    });
    handle.done.then((exitCode) => {
      if (aborting) return; // drain path owns the resolution
      if (timer) clearTimeout(timer);
      finish({ exitCode, timedOut: false, costExceeded: false });
    });
  });
}

function serializeEvent(event: { type: string; chunks: unknown; costUsd?: number }): unknown {
  return { chunks: event.chunks, costUsd: event.costUsd };
}

/**
 * Spawn a fresh agent session for `job`, stream-parse its stdout into the log
 * broker via the agent's parser, accumulate cost/tokens, and persist final usage
 * on the job. The agent (claude, codex, …) is resolved from `job.agent` unless a
 * provider is injected. Cost comes from the stream when the agent reports it,
 * otherwise it is estimated from tokens × the agent's pricing (ADR 009).
 */
export async function spawnAgentSession(
  job: Job,
  prompt: string,
  cwd: string,
  deps: AgentSessionDeps = {},
): Promise<AgentSessionResult> {
  const db = deps.db ?? getDb();
  const runner = deps.runner ?? spawnStreamRunner;
  const broker = deps.broker ?? getBroker();
  const provider = deps.provider ?? getAgentProvider(job.agent);
  const command = deps.command ?? provider.defaultCommand;
  const model = job.model ?? provider.defaultModel;
  const parser = provider.createParser();
  parser.onParseError = (error) => broker.publish(job.id, { type: "parse_error", payload: error });

  // Out-of-band side sessions never touch the job lifecycle: forcing `working`
  // would throw InvalidTransitionError for any job past `working` (the review
  // feedback driver runs on ci_running jobs, deployment healing on merged ones).
  if (!deps.sideSession) {
    if (job.status !== "working") transitionJob(job.id, "working", { model }, db);
    else db.update(jobs).set({ model }).where(eq(jobs.id, job.id)).run();
  }

  // Per-job cost ceiling (issue #57): price the accumulated usage live and trip
  // a guard that aborts the subprocess the first time it crosses the cap. Cost
  // comes from the stream when the agent reports it, otherwise the token
  // estimate — the same source used for the final persisted cost below. Cache
  // tokens are included: claude sessions are cache-dominated, so pricing only
  // non-cache input/output would see a fraction of the real spend.
  const liveCost = () =>
    parser.costUsd > 0
      ? parser.costUsd
      : provider.estimateCost(
          model,
          parser.totalInputTokens,
          parser.totalOutputTokens,
          parser.totalCacheCreationInputTokens,
          parser.totalCacheReadInputTokens,
        );
  const guard =
    deps.costCapUsd && deps.costCapUsd > 0 ? makeCostGuard(deps.costCapUsd, liveCost) : undefined;

  const args = provider.buildStartArgs({ prompt, model, maxTurns: job.maxTurns });
  const handle = runner(command, args, cwd, {
    onStdout: (chunk) => {
      for (const event of parser.push(chunk)) {
        broker.publish(job.id, { type: event.type, payload: serializeEvent(event) });
      }
      guard?.observe();
    },
    onStderr: (chunk) => broker.publish(job.id, { type: "error", payload: { stderr: chunk } }),
  });

  registerAbort(job.id, handle.abort);
  const { exitCode, timedOut, costExceeded } = await awaitBounded(handle, {
    timeoutMs: deps.timeoutMs,
    costTripped: guard?.tripped,
    graceMs: deps.graceMs,
  });
  clearAbort(job.id);
  // Spawn errors (ENOENT etc.) are readable after done settles; not applicable
  // to the timeout/cost-exceeded paths where done may not have resolved yet.
  const spawnError = !timedOut && !costExceeded ? handle.spawnError : undefined;
  if (timedOut) {
    broker.publish(job.id, {
      type: "error",
      payload: { stderr: `session timed out after ${deps.timeoutMs}ms` },
    });
  }
  if (costExceeded) {
    broker.publish(job.id, {
      type: "error",
      payload: { stderr: `session aborted: per-job cost limit of $${deps.costCapUsd} reached` },
    });
  }
  for (const event of parser.flush()) {
    broker.publish(job.id, { type: event.type, payload: serializeEvent(event) });
  }

  const costUsd =
    parser.costUsd > 0
      ? parser.costUsd
      : provider.estimateCost(
          model,
          parser.totalInputTokens,
          parser.totalOutputTokens,
          parser.totalCacheCreationInputTokens,
          parser.totalCacheReadInputTokens,
        );

  if (deps.sideSession) {
    // A side session adds to the job's bill but must not clobber the main
    // session id (CI fixes resume it) or reset the accumulated usage. The
    // increments happen inside the UPDATE so overlapping side sessions (or a
    // side session racing the main session's final write) never lose spend
    // to a read-then-write race.
    db.update(jobs)
      .set({
        totalInputTokens: sql`coalesce(${jobs.totalInputTokens}, 0) + ${parser.totalInputTokens}`,
        totalOutputTokens: sql`coalesce(${jobs.totalOutputTokens}, 0) + ${parser.totalOutputTokens}`,
        costUsd: sql`coalesce(${jobs.costUsd}, 0) + ${costUsd}`,
      })
      .where(eq(jobs.id, job.id))
      .run();
  } else {
    db.update(jobs)
      .set({
        sessionId: parser.sessionId,
        totalInputTokens: parser.totalInputTokens,
        totalOutputTokens: parser.totalOutputTokens,
        costUsd,
      })
      .where(eq(jobs.id, job.id))
      .run();
  }

  return {
    exitCode,
    sessionId: parser.sessionId,
    costUsd,
    inputTokens: parser.totalInputTokens,
    outputTokens: parser.totalOutputTokens,
    timedOut,
    costExceeded,
    spawnError,
  };
}

/**
 * Resume an existing session to fix CI, with the agent's cheaper resume model
 * and a tighter turn budget. Streams into the broker like spawnAgentSession.
 * Used by the CI babysitter. Agents without a resume mechanism fall back to a
 * fresh, context-less fix attempt (SPEC §6.3 open question).
 */
export async function resumeAgentSession(
  job: Job,
  sessionId: string,
  failedLog: string,
  cwd: string,
  deps: AgentSessionDeps = {},
): Promise<AgentSessionResult> {
  const db = deps.db ?? getDb();
  const runner = deps.runner ?? spawnStreamRunner;
  const broker = deps.broker ?? getBroker();
  const provider = deps.provider ?? getAgentProvider(job.agent);
  const command = deps.command ?? provider.defaultCommand;
  // Price what is actually executed: resumes always run the provider's resume
  // model (see the args below), never the job's start model. Pricing job.model
  // here would under-/over-count every estimated resume (codex has no stream
  // cost at all, so the estimate is its only cost source).
  const model = provider.resumeModel;
  const parser = provider.createParser();
  parser.onParseError = (error) => broker.publish(job.id, { type: "parse_error", payload: error });
  const prompt = renderTemplate(resolveTemplateContent(job.repoId, TEMPLATE_NAMES.ciFix, db), {
    CI_LOG: failedLog,
  });

  // Per-job cost ceiling (issue #57, #94): seed the guard with whatever the job
  // already spent in prior sessions so the cap applies to the cumulative job
  // spend, not just this invocation. Without this each CI-fix resume gets a
  // fresh full budget and the effective cap becomes (1 + MAX_CI_RETRIES) × cap.
  const priorCostUsd =
    deps.costCapUsd && deps.costCapUsd > 0
      ? (db.select().from(jobs).where(eq(jobs.id, job.id)).get()?.costUsd ?? 0)
      : 0;
  const liveCost = () => {
    const thisInvocation =
      parser.costUsd > 0
        ? parser.costUsd
        : provider.estimateCost(
            model,
            parser.totalInputTokens,
            parser.totalOutputTokens,
            parser.totalCacheCreationInputTokens,
            parser.totalCacheReadInputTokens,
          );
    return priorCostUsd + thisInvocation;
  };
  const guard =
    deps.costCapUsd && deps.costCapUsd > 0 ? makeCostGuard(deps.costCapUsd, liveCost) : undefined;

  const resumeArgs = provider.supportsResume
    ? provider.buildResumeArgs({
        prompt,
        sessionId,
        model,
        maxTurns: provider.resumeMaxTurns,
      })
    : null;
  // Fallback: agents that can't resume retry from scratch with the fix prompt.
  const args =
    resumeArgs ??
    provider.buildStartArgs({
      prompt,
      model,
      maxTurns: provider.resumeMaxTurns,
    });

  const handle = runner(command, args, cwd, {
    onStdout: (chunk) => {
      for (const event of parser.push(chunk)) {
        broker.publish(job.id, { type: event.type, payload: { chunks: event.chunks } });
      }
      guard?.observe();
    },
    onStderr: (chunk) => broker.publish(job.id, { type: "error", payload: { stderr: chunk } }),
  });
  registerAbort(job.id, handle.abort);
  const { exitCode, timedOut, costExceeded } = await awaitBounded(handle, {
    timeoutMs: deps.timeoutMs,
    costTripped: guard?.tripped,
    graceMs: deps.graceMs,
  });
  clearAbort(job.id);
  const spawnError = !timedOut && !costExceeded ? handle.spawnError : undefined;
  if (timedOut) {
    broker.publish(job.id, {
      type: "error",
      payload: { stderr: `session timed out after ${deps.timeoutMs}ms` },
    });
  }
  if (costExceeded) {
    broker.publish(job.id, {
      type: "error",
      payload: { stderr: `session aborted: per-job cost limit of $${deps.costCapUsd} reached` },
    });
  }
  for (const event of parser.flush()) {
    broker.publish(job.id, { type: event.type, payload: { chunks: event.chunks } });
  }

  const costUsd =
    parser.costUsd > 0
      ? parser.costUsd
      : provider.estimateCost(
          model,
          parser.totalInputTokens,
          parser.totalOutputTokens,
          parser.totalCacheCreationInputTokens,
          parser.totalCacheReadInputTokens,
        );

  // Persist usage additively: a resume continues the same job, so its cost and
  // tokens accumulate on top of whatever the initial session already recorded.
  const current = db.select().from(jobs).where(eq(jobs.id, job.id)).get();
  db.update(jobs)
    .set({
      sessionId: parser.sessionId ?? sessionId,
      totalInputTokens: (current?.totalInputTokens ?? 0) + parser.totalInputTokens,
      totalOutputTokens: (current?.totalOutputTokens ?? 0) + parser.totalOutputTokens,
      costUsd: (current?.costUsd ?? 0) + costUsd,
    })
    .where(eq(jobs.id, job.id))
    .run();

  return {
    exitCode,
    sessionId: parser.sessionId ?? sessionId,
    costUsd,
    inputTokens: parser.totalInputTokens,
    outputTokens: parser.totalOutputTokens,
    timedOut,
    costExceeded,
    spawnError,
  };
}
