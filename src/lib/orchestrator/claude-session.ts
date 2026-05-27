import { eq } from "drizzle-orm";
import { type DB, getDb } from "@/lib/db/client";
import type { Job } from "@/lib/db/schema";
import { jobs } from "@/lib/db/schema";
import { type StreamRunner, spawnStreamRunner } from "@/lib/exec/stream-runner";
import { TEMPLATE_NAMES } from "@/lib/prompts/defaults";
import { renderTemplate, resolveTemplateContent } from "@/lib/prompts/templates";
import { getBroker, type LogBroker } from "@/lib/stream/broker";
import { StreamJsonParser } from "@/lib/stream/parser";
import { transitionJob } from "./jobs";
import { estimateCost } from "./pricing";
import { clearAbort, registerAbort } from "./singleton";

export interface ClaudeSessionDeps {
  runner?: StreamRunner;
  db?: DB;
  broker?: LogBroker;
}

export interface ClaudeSessionResult {
  exitCode: number;
  sessionId?: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/** SPEC §6.3 CI-retry invocation: resume the session with Haiku, fewer turns. */
export function buildResumeArgs(
  prompt: string,
  sessionId: string,
  model = "claude-haiku-4-5",
  maxTurns = 15,
): string[] {
  return [
    "-p",
    prompt,
    "--resume",
    sessionId,
    "--max-turns",
    String(maxTurns),
    "--model",
    model,
    "--output-format",
    "stream-json",
    "--verbose",
  ];
}

export function buildClaudeArgs(prompt: string, model: string, maxTurns: number): string[] {
  // SPEC §6.2 invocation.
  return [
    "-p",
    prompt,
    "--max-turns",
    String(maxTurns),
    "--permission-mode",
    "acceptEdits",
    "--model",
    model,
    "--output-format",
    "stream-json",
    "--verbose",
  ];
}

/**
 * Spawn a real `claude -p` session, stream-parse its NDJSON stdout into the log
 * broker, accumulate cost/tokens, and persist final usage on the job. Cost comes
 * from the result event's `total_cost_usd` when present, otherwise estimated from
 * tokens × pricing (ADR 009).
 */
export async function spawnClaudeSession(
  job: Job,
  prompt: string,
  cwd: string,
  deps: ClaudeSessionDeps = {},
): Promise<ClaudeSessionResult> {
  const db = deps.db ?? getDb();
  const runner = deps.runner ?? spawnStreamRunner;
  const broker = deps.broker ?? getBroker();
  const model = job.model ?? "claude-opus-4-7";
  const parser = new StreamJsonParser();

  if (job.status !== "working") transitionJob(job.id, "working", { model }, db);
  else db.update(jobs).set({ model }).where(eq(jobs.id, job.id)).run();

  const handle = runner("claude", buildClaudeArgs(prompt, model, job.maxTurns), cwd, {
    onStdout: (chunk) => {
      for (const event of parser.push(chunk)) {
        broker.publish(job.id, { type: event.type, payload: serializeEvent(event) });
      }
    },
    onStderr: (chunk) => broker.publish(job.id, { type: "error", payload: { stderr: chunk } }),
  });

  // Allow graceful shutdown / manual abort to SIGTERM this subprocess.
  registerAbort(job.id, handle.abort);
  const exitCode = await handle.done;
  clearAbort(job.id);
  for (const event of parser.flush()) {
    broker.publish(job.id, { type: event.type, payload: serializeEvent(event) });
  }

  const costUsd =
    parser.costUsd > 0
      ? parser.costUsd
      : estimateCost(model, parser.totalInputTokens, parser.totalOutputTokens);

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

function serializeEvent(event: { type: string; chunks: unknown; costUsd?: number }): unknown {
  return { chunks: event.chunks, costUsd: event.costUsd };
}

/**
 * Resume an existing Claude session to fix CI, with Haiku and fewer turns.
 * Streams into the broker like spawnClaudeSession. Used by the CI babysitter.
 */
export async function resumeClaudeSession(
  job: Job,
  sessionId: string,
  failedLog: string,
  cwd: string,
  deps: ClaudeSessionDeps = {},
): Promise<ClaudeSessionResult> {
  const db = deps.db ?? getDb();
  const runner = deps.runner ?? spawnStreamRunner;
  const broker = deps.broker ?? getBroker();
  const parser = new StreamJsonParser();
  const prompt = renderTemplate(resolveTemplateContent(job.repoId, TEMPLATE_NAMES.ciFix, db), {
    CI_LOG: failedLog,
  });

  const handle = runner("claude", buildResumeArgs(prompt, sessionId), cwd, {
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

  const model = job.model ?? "claude-haiku-4-5";
  const costUsd =
    parser.costUsd > 0
      ? parser.costUsd
      : estimateCost(model, parser.totalInputTokens, parser.totalOutputTokens);

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
