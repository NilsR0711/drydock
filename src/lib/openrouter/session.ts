import { eq, sql } from "drizzle-orm";
import { classifyOpenRouterHttpError } from "@/lib/agents/openrouter-limits";
import { type DB, getDb } from "@/lib/db/client";
import { getRepo } from "@/lib/db/queries";
import { type Job, jobs } from "@/lib/db/schema";
import type { AgentSessionResult } from "@/lib/orchestrator/agent-session";
import { transitionJob } from "@/lib/orchestrator/jobs";
import { agentLimitBlocked } from "@/lib/orchestrator/provider-limit";
import { clearAbort, registerAbort } from "@/lib/orchestrator/singleton";
import { getSettings, type Settings } from "@/lib/settings/service";
import { getBroker, type LogBroker } from "@/lib/stream/broker";
import type { ContentChunk } from "@/lib/stream/parser";
import { catalogCostEstimate, getOpenRouterModel, isModelAvailable } from "./catalog";
import { chatCompletion, OpenRouterHttpError, type OpenRouterMessage } from "./client";
import { resolveOpenRouterApiKey } from "./config";
import { executeOpenRouterTool, OPENROUTER_SESSION_TOOLS, type ToolExecutor } from "./tools";

/**
 * Implementation session over the OpenRouter API (issue #169, ADR 032): the
 * HTTP counterpart of a CLI agent session. A tool-capable model edits the
 * worktree through a bounded tool loop (read/write/list/run), with the same
 * orchestrator guarantees as CLI sessions — wall-clock timeout, per-job cost
 * cap, abort registration, provider-limit gating/classification, and usage
 * persisted to the job row. Mirrors {@link AgentSessionResult} so run-job and
 * the babysitter stay provider-agnostic.
 */

/** Sentinel exit codes, matching the CLI session runner's contract. */
const TIMED_OUT_EXIT = -1;
const COST_EXCEEDED_EXIT = -2;
const LIMIT_BLOCKED_EXIT = -3;

const SYSTEM_PROMPT = [
  "You are Drydock's autonomous coding agent working inside a git worktree;",
  "all tool paths are relative to the repository root.",
  "Make the requested changes by reading and writing files and running commands",
  "(tests, linters, builds). Do not commit, push, branch, or open pull requests —",
  "the orchestrator handles all git operations after you finish.",
  "When the task is complete, reply with a short summary of what you changed.",
].join(" ");

export interface OpenRouterSessionDeps {
  db?: DB;
  broker?: LogBroker;
  /** Hard wall-clock timeout in ms; non-positive disables it. */
  timeoutMs?: number;
  /** Per-job USD cost ceiling; non-positive disables it. */
  costCapUsd?: number;
  /** Out-of-band side session: leave job state untouched, add usage. */
  sideSession?: boolean;
  /** Accumulate usage additively (resume-style invocations). */
  additive?: boolean;
  /** Turn budget (one chat completion per turn); defaults to job.maxTurns. */
  maxTurns?: number;
  fetchImpl?: typeof fetch;
  toolExecutor?: ToolExecutor;
}

interface SessionFailure {
  message: string;
}

/** Pre-flight config/capability checks; a failure means "could not start". */
function preflight(job: Job, model: string, settings: Settings, db: DB): SessionFailure | null {
  if (!settings.openrouterEnabled) {
    return { message: "OpenRouter backend is disabled — enable it in Settings before use" };
  }
  if (!resolveOpenRouterApiKey(settings)) {
    return {
      message:
        "no OpenRouter API key configured — set it in Settings or via DRYDOCK_OPENROUTER_API_KEY",
    };
  }
  if (!model) {
    return {
      message: `job ${job.id} has no OpenRouter model — set one on the job, the repo, or settings.openrouterDefaultModel`,
    };
  }
  const row = getOpenRouterModel(model, db);
  if (!row || !isModelAvailable(row)) {
    return {
      message: `OpenRouter model "${model}" is not in the synced catalog (or no longer available) — refresh the catalog in Settings or pick a different model`,
    };
  }
  if (!row.supportsTools) {
    return {
      message: `OpenRouter model "${model}" does not support tools — implementation sessions need a tool-capable model`,
    };
  }
  if (settings.openrouterFreeModelsOnly && !row.isFree) {
    return {
      message: `OpenRouter model "${model}" is not free and the free-models-only policy is enabled`,
    };
  }
  return null;
}

export async function runOpenRouterJobSession(
  job: Job,
  prompt: string,
  cwd: string,
  deps: OpenRouterSessionDeps = {},
): Promise<AgentSessionResult> {
  const db = deps.db ?? getDb();
  const broker = deps.broker ?? getBroker();
  const settings = getSettings(db);
  const executor = deps.toolExecutor ?? executeOpenRouterTool;
  const repo = getRepo(job.repoId, db);
  const model = job.model ?? repo?.defaultModel ?? settings.openrouterDefaultModel;

  const empty = {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    timedOut: false,
    costExceeded: false,
  };

  // Pre-spawn limit gate (ADR 030): a latched provider refuses the session
  // before any job-state or HTTP spend, same as the CLI runner.
  const latch = agentLimitBlocked("openrouter", db);
  if (latch) {
    broker.publish(job.id, {
      type: "error",
      payload: {
        stderr: `session not started: OpenRouter is limit-blocked (${latch.kind}) until ${new Date(latch.blockedUntil * 1000).toISOString()}`,
      },
    });
    return {
      exitCode: LIMIT_BLOCKED_EXIT,
      ...empty,
      limit: {
        agent: "openrouter",
        kind: latch.kind,
        resetAt: latch.blockedUntil,
        rawSnippet: latch.rawSnippet,
        latched: true,
      },
    };
  }

  const failed = preflight(job, model, settings, db);
  if (failed) {
    broker.publish(job.id, { type: "error", payload: { stderr: failed.message } });
    return { exitCode: 1, ...empty, spawnError: new Error(failed.message) };
  }

  // Resumes (additive) and side sessions never touch the job lifecycle —
  // matching the CLI runner, where only a fresh main session claims `working`.
  if (!deps.sideSession && !deps.additive) {
    if (job.status !== "working") transitionJob(job.id, "working", { model }, db);
    else db.update(jobs).set({ model }).where(eq(jobs.id, job.id)).run();
  }

  const maxTurns = deps.maxTurns ?? job.maxTurns;
  const apiKey = resolveOpenRouterApiKey(settings);
  const messages: OpenRouterMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: prompt },
  ];

  const deadline =
    deps.timeoutMs && deps.timeoutMs > 0 ? Date.now() + deps.timeoutMs : Number.POSITIVE_INFINITY;
  const controller = new AbortController();
  registerAbort(job.id, () => controller.abort());
  // One session-wide deadline timer (not per request): the abort must also
  // fire while a tool command is running, not only during chat completions.
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  if (Number.isFinite(deadline) && deps.timeoutMs) {
    deadlineTimer = setTimeout(() => controller.abort(), deps.timeoutMs);
    deadlineTimer.unref?.();
  }

  let costUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let exitCode = 0;
  let timedOut = false;
  let costExceeded = false;
  let limit: AgentSessionResult["limit"];

  try {
    let turn = 0;
    for (;;) {
      // Timeout first: the deadline timer also aborts the controller, so a
      // timed-out session must not be misreported as an operator abort.
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        timedOut = true;
        exitCode = TIMED_OUT_EXIT;
        broker.publish(job.id, {
          type: "error",
          payload: { stderr: `session timed out after ${deps.timeoutMs}ms` },
        });
        break;
      }
      if (controller.signal.aborted) {
        exitCode = 1;
        broker.publish(job.id, { type: "error", payload: { stderr: "session aborted" } });
        break;
      }
      if (turn >= maxTurns) {
        exitCode = 1;
        broker.publish(job.id, {
          type: "error",
          payload: { stderr: `OpenRouter session exhausted its ${maxTurns}-turn budget` },
        });
        break;
      }
      turn += 1;

      const completion = await chatCompletion({
        apiKey,
        model,
        messages,
        tools: OPENROUTER_SESSION_TOOLS,
        siteUrl: settings.openrouterSiteUrl || undefined,
        appName: settings.openrouterAppName || undefined,
        fetchImpl: deps.fetchImpl,
        signal: controller.signal,
      });

      inputTokens += completion.usage.promptTokens;
      outputTokens += completion.usage.completionTokens;
      costUsd +=
        completion.usage.costUsd > 0
          ? completion.usage.costUsd
          : catalogCostEstimate(
              model,
              completion.usage.promptTokens,
              completion.usage.completionTokens,
              db,
            );

      const chunks: ContentChunk[] = [];
      if (completion.text) chunks.push({ kind: "text", text: completion.text });
      for (const call of completion.toolCalls) {
        let input: unknown = call.arguments;
        try {
          input = JSON.parse(call.arguments);
        } catch {
          // keep the raw string — display only
        }
        chunks.push({ kind: "tool_use", name: call.name, id: call.id, input });
      }
      if (chunks.length > 0) {
        broker.publish(job.id, { type: "assistant", payload: { chunks, costUsd } });
      }

      // Per-job cost ceiling (issue #57): same semantics as the CLI runner —
      // abort the session the first time the accumulated cost reaches the cap.
      if (deps.costCapUsd && deps.costCapUsd > 0 && costUsd >= deps.costCapUsd) {
        costExceeded = true;
        exitCode = COST_EXCEEDED_EXIT;
        broker.publish(job.id, {
          type: "error",
          payload: { stderr: `session aborted: per-job cost limit of $${deps.costCapUsd} reached` },
        });
        break;
      }

      if (completion.finishReason !== "tool_calls" || completion.toolCalls.length === 0) {
        break; // the model is done (stop/length) — session complete
      }

      messages.push({
        role: "assistant",
        content: completion.text,
        toolCalls: completion.toolCalls,
      });
      for (const call of completion.toolCalls) {
        // Hand the executor the session's abort signal and remaining budget so
        // a long-running command can never outlive the deadline or ignore an
        // operator abort.
        const result = await executor(call, cwd, {
          signal: controller.signal,
          timeoutMs: Number.isFinite(deadline) ? Math.max(1, deadline - Date.now()) : undefined,
        });
        if (controller.signal.aborted) {
          // The loop head settles whether this was a timeout or an abort.
          messages.push({ role: "tool", content: "ERROR: session aborted", toolCallId: call.id });
          break;
        }
        broker.publish(job.id, {
          type: "user",
          payload: {
            chunks: [{ kind: "tool_result", toolUseId: call.id, isError: result.isError }],
          },
        });
        messages.push({
          role: "tool",
          content: result.isError ? `ERROR: ${result.content}` : result.content,
          toolCallId: call.id,
        });
      }
    }
  } catch (err) {
    if (controller.signal.aborted && deadline <= Date.now()) {
      timedOut = true;
      exitCode = TIMED_OUT_EXIT;
      broker.publish(job.id, {
        type: "error",
        payload: { stderr: `session timed out after ${deps.timeoutMs}ms` },
      });
    } else if (err instanceof OpenRouterHttpError) {
      exitCode = 1;
      limit = classifyOpenRouterHttpError(err);
      broker.publish(job.id, { type: "error", payload: { stderr: err.message.slice(0, 2000) } });
    } else {
      exitCode = 1;
      broker.publish(job.id, {
        type: "error",
        payload: { stderr: err instanceof Error ? err.message : String(err) },
      });
    }
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    clearAbort(job.id);
  }

  if (deps.sideSession || deps.additive) {
    // Additive persistence: resumes and side sessions add to the job's bill
    // without clobbering prior usage (same contract as the CLI runner).
    db.update(jobs)
      .set({
        totalInputTokens: sql`coalesce(${jobs.totalInputTokens}, 0) + ${inputTokens}`,
        totalOutputTokens: sql`coalesce(${jobs.totalOutputTokens}, 0) + ${outputTokens}`,
        costUsd: sql`coalesce(${jobs.costUsd}, 0) + ${costUsd}`,
      })
      .where(eq(jobs.id, job.id))
      .run();
  } else {
    db.update(jobs)
      .set({ totalInputTokens: inputTokens, totalOutputTokens: outputTokens, costUsd })
      .where(eq(jobs.id, job.id))
      .run();
  }

  return { exitCode, costUsd, inputTokens, outputTokens, timedOut, costExceeded, limit };
}
