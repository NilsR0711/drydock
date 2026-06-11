import { beforeEach, describe, expect, it } from "vitest";
import { openrouterProvider } from "@/lib/agents/openrouter";
import { createDb, type DB } from "@/lib/db/client";
import { oneShotCosts, openrouterModels } from "@/lib/db/schema";
import { runOpenRouterOneShot } from "@/lib/openrouter/one-shot";
import { runOneShotAndRecordCost } from "@/lib/orchestrator/one-shot-runner";
import { addRepo } from "@/lib/repos/service";
import { saveSettings } from "@/lib/settings/service";

function sse(...events: string[]): string {
  return `${events.map((e) => `data: ${e}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
}

function answerStream(text: string, cost = 0.001): string {
  return sse(
    JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] }),
    JSON.stringify({
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 50, cost },
    }),
  );
}

const MODEL = "meta-llama/llama-3.3-70b-instruct:free";

let db: DB;
let repoId: number;
beforeEach(() => {
  db = createDb(":memory:");
  repoId = addRepo({ path: "/tmp/r", name: "r" }, db).id;
  db.insert(openrouterModels)
    .values({
      id: MODEL,
      name: "Llama 3.3 70B (free)",
      supportedParameters: '["tools"]',
      supportsTools: true,
      isFree: true,
      promptCostPerToken: 0,
      completionCostPerToken: 0,
      syncedAt: 1,
    })
    .run();
  saveSettings({ openrouterEnabled: true, openrouterApiKey: "sk-or-v1-k" }, db);
});

describe("runOpenRouterOneShot (issue #169)", () => {
  it("returns the answer text and records the reported cost", async () => {
    const res = await runOpenRouterOneShot({
      model: MODEL,
      prompt: "say hi",
      repoId,
      type: "decompose",
      db,
      fetchImpl: async () => new Response(answerStream("hi there", 0.002), { status: 200 }),
    });
    expect(res.exitCode).toBe(0);
    expect(res.text).toBe("hi there");
    expect(res.costUsd).toBe(0.002);
    const rows = db.select().from(oneShotCosts).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ repoId, type: "decompose", costUsd: 0.002 });
  });

  it("estimates cost from catalog pricing when the stream reports zero cost", async () => {
    db.insert(openrouterModels)
      .values({
        id: "openai/gpt-4o-mini",
        name: "GPT-4o-mini",
        supportedParameters: "[]",
        supportsTools: true,
        isFree: false,
        promptCostPerToken: 0.00000015,
        completionCostPerToken: 0.0000006,
        syncedAt: 1,
      })
      .run();
    const res = await runOpenRouterOneShot({
      model: "openai/gpt-4o-mini",
      prompt: "p",
      repoId,
      type: "verify",
      db,
      fetchImpl: async () => new Response(answerStream("ok", 0), { status: 200 }),
    });
    expect(res.exitCode).toBe(0);
    // 100 prompt + 50 completion tokens at the catalog's per-token USD rates.
    expect(res.costUsd).toBeCloseTo(100 * 0.00000015 + 50 * 0.0000006, 12);
  });

  it("fails actionably when the backend is disabled", async () => {
    saveSettings({ openrouterEnabled: false }, db);
    const res = await runOpenRouterOneShot({ model: MODEL, prompt: "p", type: "verify", db });
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toMatch(/disabled/i);
  });

  it("fails actionably without an API key", async () => {
    saveSettings({ openrouterApiKey: "" }, db);
    const res = await runOpenRouterOneShot({ model: MODEL, prompt: "p", type: "verify", db });
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toMatch(/api key/i);
  });

  it("fails actionably for a model missing from the catalog", async () => {
    const res = await runOpenRouterOneShot({
      model: "gone/model",
      prompt: "p",
      type: "verify",
      db,
    });
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toMatch(/catalog/i);
  });

  it("falls back to the global default model when none is given", async () => {
    saveSettings({ openrouterDefaultModel: MODEL }, db);
    let requestedModel = "";
    const res = await runOpenRouterOneShot({
      model: "",
      prompt: "p",
      type: "verify",
      db,
      fetchImpl: async (_u, init) => {
        requestedModel = (JSON.parse(String(init?.body)) as { model: string }).model;
        return new Response(answerStream("ok"), { status: 200 });
      },
    });
    expect(res.exitCode).toBe(0);
    expect(requestedModel).toBe(MODEL);
  });

  it("enforces the free-models-only policy", async () => {
    db.insert(openrouterModels)
      .values({
        id: "paid/model",
        name: "Paid",
        supportedParameters: "[]",
        supportsTools: false,
        isFree: false,
        promptCostPerToken: 0.00001,
        completionCostPerToken: 0.00005,
        syncedAt: 1,
      })
      .run();
    saveSettings({ openrouterFreeModelsOnly: true }, db);
    const res = await runOpenRouterOneShot({
      model: "paid/model",
      prompt: "p",
      type: "verify",
      db,
    });
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toMatch(/free/i);
  });

  it("surfaces HTTP failures in a classifiable form", async () => {
    const res = await runOpenRouterOneShot({
      model: MODEL,
      prompt: "p",
      type: "verify",
      db,
      fetchImpl: async () => new Response("Rate limit exceeded", { status: 429 }),
    });
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain("OpenRouter HTTP 429");
    expect(openrouterProvider.classifyFailure?.({ exitCode: 1, stderr: res.stderr })?.kind).toBe(
      "rate_limit",
    );
  });
});

describe("runOneShotAndRecordCost dispatch (issue #169)", () => {
  it("routes http providers to the OpenRouter one-shot instead of spawning a CLI", async () => {
    const res = await runOneShotAndRecordCost({
      provider: openrouterProvider,
      command: "",
      model: MODEL,
      cwd: "/tmp",
      prompt: "say hi",
      repoId,
      type: "pr_audit",
      db,
      fetchImpl: async () => new Response(answerStream("routed", 0.001), { status: 200 }),
      runner: async () => {
        throw new Error("CLI runner must not be called for http providers");
      },
    });
    expect(res.exitCode).toBe(0);
    expect(res.text).toBe("routed");
    expect(db.select().from(oneShotCosts).all()).toHaveLength(1);
  });
});
