import { eq } from "drizzle-orm";
import { getAgentProvider } from "@/lib/agents/registry";
import type { AgentProvider } from "@/lib/agents/types";
import { type DB, getDb } from "@/lib/db/client";
import type { Job } from "@/lib/db/schema";
import { jobs } from "@/lib/db/schema";
import { type StreamRunner, spawnStreamRunner } from "@/lib/exec/stream-runner";
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
}

export interface AgentSessionResult {
  exitCode: number;
  sessionId?: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
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

  if (job.status !== "working") transitionJob(job.id, "working", { model }, db);
  else db.update(jobs).set({ model }).where(eq(jobs.id, job.id)).run();

  const args = provider.buildStartArgs({ prompt, model, maxTurns: job.maxTurns });
  const handle = runner(command, args, cwd, {
    onStdout: (chunk) => {
      for (const event of parser.push(chunk)) {
        broker.publish(job.id, { type: event.type, payload: serializeEvent(event) });
      }
    },
    onStderr: (chunk) => broker.publish(job.id, { type: "error", payload: { stderr: chunk } }),
  });

  registerAbort(job.id, handle.abort);
  const exitCode = await handle.done;
  clearAbort(job.id);
  for (const event of parser.flush()) {
    broker.publish(job.id, { type: event.type, payload: serializeEvent(event) });
  }

  const costUsd =
    parser.costUsd > 0
      ? parser.costUsd
      : provider.estimateCost(model, parser.totalInputTokens, parser.totalOutputTokens);

  db.update(jobs)
    .set({
      sessionId: parser.sessionId,
      totalInputTokens: parser.totalInputTokens,
      totalOutputTokens: parser.totalOutputTokens,
      costUsd,
    })
    .where(eq(jobs.id, job.id))
    .run();

  return {
    exitCode,
    sessionId: parser.sessionId,
    costUsd,
    inputTokens: parser.totalInputTokens,
    outputTokens: parser.totalOutputTokens,
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
  const parser = provider.createParser();
  parser.onParseError = (error) => broker.publish(job.id, { type: "parse_error", payload: error });
  const prompt = renderTemplate(resolveTemplateContent(job.repoId, TEMPLATE_NAMES.ciFix, db), {
    CI_LOG: failedLog,
  });

  const resumeArgs = provider.supportsResume
    ? provider.buildResumeArgs({
        prompt,
        sessionId,
        model: provider.resumeModel,
        maxTurns: provider.resumeMaxTurns,
      })
    : null;
  // Fallback: agents that can't resume retry from scratch with the fix prompt.
  const args =
    resumeArgs ??
    provider.buildStartArgs({
      prompt,
      model: provider.resumeModel,
      maxTurns: provider.resumeMaxTurns,
    });

  const handle = runner(command, args, cwd, {
    onStdout: (chunk) => {
      for (const event of parser.push(chunk)) {
        broker.publish(job.id, { type: event.type, payload: { chunks: event.chunks } });
      }
    },
    onStderr: (chunk) => broker.publish(job.id, { type: "error", payload: { stderr: chunk } }),
  });
  registerAbort(job.id, handle.abort);
  const exitCode = await handle.done;
  clearAbort(job.id);
  for (const event of parser.flush()) {
    broker.publish(job.id, { type: event.type, payload: { chunks: event.chunks } });
  }

  const model = job.model ?? provider.resumeModel;
  const costUsd =
    parser.costUsd > 0
      ? parser.costUsd
      : provider.estimateCost(model, parser.totalInputTokens, parser.totalOutputTokens);

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
  };
}
