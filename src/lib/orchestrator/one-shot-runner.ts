import type { AgentProvider } from "@/lib/agents/types";
import { type DB, getDb } from "@/lib/db/client";
import { oneShotCosts } from "@/lib/db/schema";
import { type CommandOptions, type CommandRunner, spawnRunner } from "@/lib/exec/runner";
import { StreamJsonParser } from "@/lib/stream/parser";

export type OneShotType = "verify" | "decompose" | "pr-question" | "release";

export interface OneShotResult {
  /** Plain text extracted from assistant events (empty string if none). */
  text: string;
  exitCode: number;
  costUsd: number;
}

/**
 * Run a one-shot agent call in stream-json mode (when the provider supports it),
 * extract the plain text response, record the cost to `oneShotCosts`, and return
 * both. When the provider does not support stream-json one-shots (e.g. Codex),
 * falls back to the plain `buildOneShotArgs` path without cost recording.
 */
export async function runOneShotAndRecordCost(opts: {
  provider: AgentProvider;
  command: string;
  model: string;
  cwd: string;
  prompt: string;
  /** When omitted, cost is tracked in memory only (no DB row). */
  repoId?: number;
  type: OneShotType;
  timeoutMs?: number;
  runner?: CommandRunner;
  db?: DB;
}): Promise<OneShotResult> {
  const runner = opts.runner ?? spawnRunner;
  const db = opts.db ?? getDb();
  const cmdOpts: CommandOptions | undefined =
    opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : undefined;

  const streamArgs = opts.provider.buildStreamOneShotArgs({
    prompt: opts.prompt,
    model: opts.model,
  });

  if (streamArgs === null) {
    // Provider does not support stream-json one-shots — run plain, no cost tracking.
    const plainArgs = opts.provider.buildOneShotArgs({ prompt: opts.prompt, model: opts.model });
    const res = cmdOpts
      ? await runner(opts.command, plainArgs, opts.cwd, cmdOpts)
      : await runner(opts.command, plainArgs, opts.cwd);
    return { text: res.stdout, exitCode: res.exitCode, costUsd: 0 };
  }

  const res = cmdOpts
    ? await runner(opts.command, streamArgs, opts.cwd, cmdOpts)
    : await runner(opts.command, streamArgs, opts.cwd);

  // Parse the NDJSON stream to extract text content and cost.
  const parser = new StreamJsonParser();
  const events = [...parser.push(res.stdout), ...parser.flush()];

  // Collect all text chunks from assistant events in order.
  const textParts: string[] = [];
  for (const event of events) {
    for (const chunk of event.chunks) {
      if (chunk.kind === "text") textParts.push(chunk.text);
    }
  }
  const text = textParts.join("");

  const costUsd = parser.costUsd > 0 ? parser.costUsd : 0;

  if (costUsd > 0 && opts.repoId !== undefined) {
    db.insert(oneShotCosts)
      .values({
        repoId: opts.repoId,
        type: opts.type,
        costUsd,
        inputTokens: parser.totalInputTokens,
        outputTokens: parser.totalOutputTokens,
      })
      .run();
  }

  return { text, exitCode: res.exitCode, costUsd };
}
