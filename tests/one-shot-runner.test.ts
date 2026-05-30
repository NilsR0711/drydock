import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentProvider } from "@/lib/agents/registry";
import { createDb, type DB } from "@/lib/db/client";
import { oneShotCosts } from "@/lib/db/schema";
import type { CommandResult } from "@/lib/exec/runner";
import { runOneShotAndRecordCost } from "@/lib/orchestrator/one-shot-runner";
import { addRepo } from "@/lib/repos/service";

/** Minimal stream-json one-shot response that embeds plain text. */
function oneShotNdjson(text: string, costUsd = 0.002): string {
  return `${[
    JSON.stringify({ type: "system", session_id: "s1", model: "claude-opus-4-8" }),
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        usage: { input_tokens: 80, output_tokens: 30 },
      },
    }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: costUsd,
      usage: { input_tokens: 80, output_tokens: 30 },
    }),
  ].join("\n")}\n`;
}

function fakeRunner(result: Partial<CommandResult>) {
  return vi.fn(
    async (): Promise<CommandResult> => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
      ...result,
    }),
  );
}

const provider = getAgentProvider("claude");

let db: DB;
let repoId: number;
beforeEach(() => {
  db = createDb(":memory:");
  repoId = addRepo({ path: "/r", name: "r" }, db).id;
});

describe("runOneShotAndRecordCost (issue #95)", () => {
  it("records a row in oneShotCosts after a successful run", async () => {
    const runner = fakeRunner({ stdout: oneShotNdjson("answer", 0.003) });
    await runOneShotAndRecordCost({
      provider,
      command: "claude",
      model: "claude-opus-4-8",
      cwd: "/r",
      prompt: "q",
      repoId,
      type: "verify",
      runner,
      db,
    });
    const rows = db.select().from(oneShotCosts).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.costUsd).toBeCloseTo(0.003);
    expect(rows[0]?.type).toBe("verify");
    expect(rows[0]?.repoId).toBe(repoId);
  });

  it("returns the text extracted from assistant events", async () => {
    const runner = fakeRunner({ stdout: oneShotNdjson("the answer", 0.001) });
    const result = await runOneShotAndRecordCost({
      provider,
      command: "claude",
      model: "claude-opus-4-8",
      cwd: "/r",
      prompt: "q",
      repoId,
      type: "decompose",
      runner,
      db,
    });
    expect(result.text).toBe("the answer");
  });

  it("does not record a row when cost is zero", async () => {
    const runner = fakeRunner({ stdout: oneShotNdjson("ans", 0) });
    await runOneShotAndRecordCost({
      provider,
      command: "claude",
      model: "claude-opus-4-8",
      cwd: "/r",
      prompt: "q",
      repoId,
      type: "verify",
      runner,
      db,
    });
    expect(db.select().from(oneShotCosts).all()).toHaveLength(0);
  });

  it("returns the runner exit code", async () => {
    const runner = fakeRunner({ exitCode: 1, stdout: "" });
    const result = await runOneShotAndRecordCost({
      provider,
      command: "claude",
      model: "claude-opus-4-8",
      cwd: "/r",
      prompt: "q",
      repoId,
      type: "release",
      runner,
      db,
    });
    expect(result.exitCode).toBe(1);
  });

  it("records input and output tokens from the stream", async () => {
    const runner = fakeRunner({ stdout: oneShotNdjson("x", 0.004) });
    await runOneShotAndRecordCost({
      provider,
      command: "claude",
      model: "claude-opus-4-8",
      cwd: "/r",
      prompt: "q",
      repoId,
      type: "pr-question",
      runner,
      db,
    });
    const row = db.select().from(oneShotCosts).all()[0];
    expect(row?.inputTokens).toBeGreaterThan(0);
    expect(row?.outputTokens).toBeGreaterThan(0);
  });
});
