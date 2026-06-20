import { eq, sql } from "drizzle-orm";
import { readingFromRateLimit } from "@/lib/agents/claude-usage";
import { getAgentProvider } from "@/lib/agents/registry";
import type { AgentProvider, ProviderLimitInfo, StreamParser } from "@/lib/agents/types";
import { type DB, getDb } from "@/lib/db/client";
import type { Job } from "@/lib/db/schema";
import { jobs } from "@/lib/db/schema";
import { type StreamHandle, type StreamRunner, spawnStreamRunner } from "@/lib/exec/stream-runner";
import { TEMPLATE_NAMES } from "@/lib/prompts/defaults";
import { renderTemplate, resolveTemplateContent } from "@/lib/prompts/templates";
import { getBroker, type LogBroker } from "@/lib/stream/broker";
import { agentSpawnEnv } from "./agent-command";
import { transitionJob } from "./jobs";
import { agentLimitBlocked } from "./provider-limit";
import { recordCodexUsage, saveProviderUsage } from "./provider-usage";
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
  /**
   * Limit-resume path (issue #166): override the resume prompt instead of
   * rendering the CI-fix template. A limit-parked job resumes its main work,
   * not a CI fix, so it needs its own continuation prompt.
   */
  resumePrompt?: string;
  /** Limit-resume path (issue #166): resume on this model instead of the provider's cheap resume model. */
  resumeModel?: string;
  /** Limit-resume path (issue #166): resume with this turn budget instead of the tight CI-fix budget. */
  resumeMaxTurns?: number;
  /**
   * Run the session with full, unprompted shell access (issue #256). Only an
   * agent-driven release sets this so the agent can run the repo's release
   * commands (gh/git/npm) itself; the default edits-only mode blocks them
   * headlessly.
   */
  bypassPermissions?: boolean;
  /**
   * Per-repo command allowlist (issue #329): commands pre-approved for headless
   * Bash via the provider's `--allowedTools`, layered on the default edits-only
   * mode. A safer middle ground than `bypassPermissions` for repos that only
   * need a real build/test step. Superseded by `bypassPermissions` when set.
   */
  allowedCommands?: string[];
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
   * True when the session was cut off by its positive turn budget (issue #277):
   * the CLI exits non-zero with a terminal `error_max_turns` result and no
   * provider-limit signal. A recoverable outcome — callers may resume the stored
   * session to continue the work instead of escalating it as "exited non-zero".
   */
  maxTurnsReached: boolean;
  /**
   * Set when the child process failed to spawn (e.g. ENOENT — CLI not found).
   * Distinguishes "binary missing" from a real non-zero agent exit so callers
   * can surface a clear "failed to start <command>" diagnostic.
   */
  spawnError?: Error;
  /**
   * Set when the failed session was classified as a provider limit/auth
   * condition (issue #166), or when the session was refused outright because
   * the provider is already limit-latched (then `limit.latched` is true).
   */
  limit?: SessionLimitInfo;
}

/** ProviderLimitInfo plus whether it came from the latch, not a fresh failure. */
export interface SessionLimitInfo extends ProviderLimitInfo {
  /**
   * True when the session never ran because the provider was already latched.
   * Callers park the job without re-latching, so guard bounces don't count as
   * fresh strikes and never extend the wait window.
   */
  latched?: boolean;
}

/**
 * The Claude Code `stream-json` result subtype emitted when a session is cut off
 * by `--max-turns` (issue #277). Surfaced via `parser.resultSubtype`; agents
 * without an analogous signal never set it, so detection is a no-op for them.
 */
const MAX_TURNS_RESULT_SUBTYPE = "error_max_turns";

/**
 * Whether a finished, failed session ended because it exhausted its turn budget
 * (issue #277). Drydock's own aborts (timeout, cost cap) end the session
 * incompletely too, so they are excluded up front — only a genuine
 * `error_max_turns` result counts.
 */
function reachedMaxTurns(
  parser: StreamParser,
  outcome: { timedOut: boolean; costExceeded: boolean },
): boolean {
  if (outcome.timedOut || outcome.costExceeded) return false;
  return parser.resultSubtype === MAX_TURNS_RESULT_SUBTYPE;
}

/** Sentinel exit code recorded when a session is killed by the wall-clock timeout. */
const TIMED_OUT_EXIT = -1;
/** Sentinel exit code recorded when a session is killed by the per-job cost cap. */
const COST_EXCEEDED_EXIT = -2;
/** Sentinel exit code for a session refused because the provider is limit-latched. */
const LIMIT_BLOCKED_EXIT = -3;

/** Cap on the retained stderr tail used for failure classification. */
const STDERR_TAIL_MAX = 16_384;

/**
 * Pre-spawn gate (issues #166/#167): while the provider's limit latch is
 * blocking, refuse to start a session at all — every caller (driver jobs, CI
 * fixes, review-feedback side sessions) would only burn a spawn against a
 * quota that is known to be exhausted. Returns the refusal result, or
 * undefined when the session may proceed. Latches are per agent, so only the
 * latched provider's sessions are refused.
 */
function limitGateResult(
  provider: AgentProvider,
  job: Job,
  broker: LogBroker,
  db: DB,
): AgentSessionResult | undefined {
  const latch = agentLimitBlocked(provider.id, db);
  if (!latch) return undefined;
  broker.publish(job.id, {
    type: "error",
    payload: {
      stderr: `session not started: ${provider.label} is limit-blocked (${latch.kind}) until ${new Date(latch.blockedUntil * 1000).toISOString()}`,
    },
  });
  return {
    exitCode: LIMIT_BLOCKED_EXIT,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    timedOut: false,
    costExceeded: false,
    maxTurnsReached: false,
    limit: {
      agent: provider.id,
      kind: latch.kind,
      resetAt: latch.blockedUntil,
      rawSnippet: latch.rawSnippet,
      latched: true,
    },
  };
}

/**
 * Classify a finished, failed session against the provider's limit patterns
 * (issue #166). Timeout/cost-cap aborts are Drydock's own doing, never a
 * provider condition, so they are excluded up front.
 */
function classifySessionFailure(
  provider: AgentProvider,
  parser: StreamParser,
  stderrTail: string,
  outcome: { exitCode: number; timedOut: boolean; costExceeded: boolean },
): ProviderLimitInfo | undefined {
  if (outcome.timedOut || outcome.costExceeded) return undefined;
  if (outcome.exitCode === 0 && !parser.resultIsError) return undefined;
  return provider.classifyFailure?.({
    exitCode: outcome.exitCode,
    stderr: stderrTail,
    resultText: parser.resultText,
    resultIsError: parser.resultIsError,
  });
}

/**
 * Opportunistic forward-looking usage capture (issues #188/#189): persist the
 * live quota state the CLI streamed, so the dashboard can warn before a quota
 * is exhausted. Captured from the run Drydock already performs — no extra API
 * call. Claude exposes a qualitative `rate_limit_event` (`parser.rateLimit`);
 * Codex exposes structured `rate_limits` windows via `provider.captureUsage`.
 * Agents whose CLI emits neither record nothing.
 */
function captureProviderUsage(provider: AgentProvider, parser: StreamParser, db: DB): void {
  const now = Math.floor(Date.now() / 1000);
  const claudeReading = readingFromRateLimit(parser.rateLimit, now);
  if (claudeReading) saveProviderUsage(provider.id, claudeReading, db);
  const codexReading = provider.captureUsage?.(parser);
  if (codexReading) recordCodexUsage(codexReading, db, now);
}

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

/** A job's persisted cumulative usage, used to keep streamed metrics cumulative. */
interface JobUsage {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

const ZERO_USAGE: JobUsage = { costUsd: 0, inputTokens: 0, outputTokens: 0 };

/** Read the job's already-persisted usage so additive sessions stream cumulative totals. */
function readJobUsage(db: DB, jobId: number): JobUsage {
  const row = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  return {
    costUsd: row?.costUsd ?? 0,
    inputTokens: row?.totalInputTokens ?? 0,
    outputTokens: row?.totalOutputTokens ?? 0,
  };
}

/**
 * Shape an event for the broker. Carries a running usage snapshot (live cost +
 * accumulated token totals) alongside the chunks so the job detail's metric
 * cards can refresh mid-run instead of only at the terminal `result` event
 * (issue #242). Callers pass cumulative totals so additive sessions never
 * regress the figure the UI already shows.
 */
function serializeEvent(event: { chunks: unknown }, usage: JobUsage): unknown {
  return {
    chunks: event.chunks,
    costUsd: usage.costUsd,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
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

  // Pre-spawn limit gate (issue #166): a latched provider refuses the session
  // before any job-state or DB write happens.
  const gated = limitGateResult(provider, job, broker, db);
  if (gated) return gated;

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
  // Running usage published with every event so the UI metric cards tick live
  // (issue #242). A side session persists additively, so its snapshot must
  // include the job's prior spend or the cards would visibly regress to this
  // invocation's totals; a main session replaces the totals, so it starts at 0.
  const priorUsage = deps.sideSession ? readJobUsage(db, job.id) : ZERO_USAGE;
  const usageSnapshot = () => ({
    costUsd: priorUsage.costUsd + liveCost(),
    inputTokens: priorUsage.inputTokens + parser.totalInputTokens,
    outputTokens: priorUsage.outputTokens + parser.totalOutputTokens,
  });

  const args = provider.buildStartArgs({
    prompt,
    model,
    maxTurns: job.maxTurns,
    bypassPermissions: deps.bypassPermissions,
    allowedCommands: deps.allowedCommands,
  });
  // Tail of stderr, retained for provider-limit classification (issue #166).
  let stderrTail = "";
  const handle = runner(
    command,
    args,
    cwd,
    {
      onStdout: (chunk) => {
        for (const event of parser.push(chunk)) {
          broker.publish(job.id, {
            type: event.type,
            payload: serializeEvent(event, usageSnapshot()),
          });
        }
        guard?.observe();
      },
      onStderr: (chunk) => {
        stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_MAX);
        broker.publish(job.id, { type: "error", payload: { stderr: chunk } });
      },
    },
    agentSpawnEnv(provider, db),
  );

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
    broker.publish(job.id, { type: event.type, payload: serializeEvent(event, usageSnapshot()) });
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

  captureProviderUsage(provider, parser, db);

  return {
    exitCode,
    sessionId: parser.sessionId,
    costUsd,
    inputTokens: parser.totalInputTokens,
    outputTokens: parser.totalOutputTokens,
    timedOut,
    costExceeded,
    maxTurnsReached: reachedMaxTurns(parser, { timedOut, costExceeded }),
    spawnError,
    limit: classifySessionFailure(provider, parser, stderrTail, {
      exitCode,
      timedOut,
      costExceeded,
    }),
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
  const prompt =
    deps.resumePrompt ??
    renderTemplate(resolveTemplateContent(job.repoId, TEMPLATE_NAMES.ciFix, db), {
      CI_LOG: failedLog,
    });
  const command = deps.command ?? provider.defaultCommand;
  // Price what is actually executed: resumes default to the provider's resume
  // model (see the args below), never the job's start model. Pricing job.model
  // here would under-/over-count every estimated resume (codex has no stream
  // cost at all, so the estimate is its only cost source). The limit-resume
  // path (issue #166) overrides this — it continues the main work, not a CI
  // fix — along with the prompt and turn budget.
  const model = deps.resumeModel ?? provider.resumeModel;
  const maxTurns = deps.resumeMaxTurns ?? provider.resumeMaxTurns;
  const parser = provider.createParser();
  parser.onParseError = (error) => broker.publish(job.id, { type: "parse_error", payload: error });

  // Pre-spawn limit gate (issue #166): same refusal as spawnAgentSession.
  const gated = limitGateResult(provider, job, broker, db);
  if (gated) return { ...gated, sessionId };

  // Per-job cost ceiling (issue #57, #94): seed the guard with whatever the job
  // already spent in prior sessions so the cap applies to the cumulative job
  // spend, not just this invocation. Without this each CI-fix resume gets a
  // fresh full budget and the effective cap becomes (1 + MAX_CI_RETRIES) × cap.
  // A resume always persists additively, so the same prior usage keeps the
  // streamed metric snapshot cumulative (issue #242).
  const priorUsage = readJobUsage(db, job.id);
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
    return priorUsage.costUsd + thisInvocation;
  };
  const guard =
    deps.costCapUsd && deps.costCapUsd > 0 ? makeCostGuard(deps.costCapUsd, liveCost) : undefined;
  // Running usage published with every event so the UI metric cards tick live.
  const usageSnapshot = () => ({
    costUsd: liveCost(),
    inputTokens: priorUsage.inputTokens + parser.totalInputTokens,
    outputTokens: priorUsage.outputTokens + parser.totalOutputTokens,
  });

  const resumeArgs = provider.supportsResume
    ? provider.buildResumeArgs({
        prompt,
        sessionId,
        model,
        maxTurns,
        bypassPermissions: deps.bypassPermissions,
        allowedCommands: deps.allowedCommands,
      })
    : null;
  // Fallback: agents that can't resume retry from scratch with the fix prompt.
  const args =
    resumeArgs ??
    provider.buildStartArgs({
      prompt,
      model,
      maxTurns,
      bypassPermissions: deps.bypassPermissions,
      allowedCommands: deps.allowedCommands,
    });

  // Tail of stderr, retained for provider-limit classification (issue #166).
  let stderrTail = "";
  const handle = runner(
    command,
    args,
    cwd,
    {
      onStdout: (chunk) => {
        for (const event of parser.push(chunk)) {
          broker.publish(job.id, {
            type: event.type,
            payload: serializeEvent(event, usageSnapshot()),
          });
        }
        guard?.observe();
      },
      onStderr: (chunk) => {
        stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_MAX);
        broker.publish(job.id, { type: "error", payload: { stderr: chunk } });
      },
    },
    agentSpawnEnv(provider, db),
  );
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
    broker.publish(job.id, { type: event.type, payload: serializeEvent(event, usageSnapshot()) });
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

  captureProviderUsage(provider, parser, db);

  return {
    exitCode,
    sessionId: parser.sessionId ?? sessionId,
    costUsd,
    inputTokens: parser.totalInputTokens,
    outputTokens: parser.totalOutputTokens,
    timedOut,
    costExceeded,
    maxTurnsReached: reachedMaxTurns(parser, { timedOut, costExceeded }),
    spawnError,
    limit: classifySessionFailure(provider, parser, stderrTail, {
      exitCode,
      timedOut,
      costExceeded,
    }),
  };
}
