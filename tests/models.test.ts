import { describe, expect, it } from "vitest";
import { CODEX_PRICING } from "@/lib/agents/codex";
import { DEFAULT_MODEL, defaultModelForAgent, MODELS, modelsForAgent } from "@/lib/models";
import { PRICING } from "@/lib/orchestrator/pricing";

describe("models", () => {
  it("defaults to Claude Opus 4.8", () => {
    expect(DEFAULT_MODEL).toBe("claude-opus-4-8");
  });

  it("lists at least Opus 4.8, Opus 4.7, Sonnet, Haiku for claude", () => {
    const ids = modelsForAgent("claude").map((m) => m.id);
    expect(ids).toContain("claude-opus-4-8");
    expect(ids).toContain("claude-opus-4-7");
    expect(ids).toContain("claude-sonnet-4-5");
    expect(ids).toContain("claude-haiku-4-5");
  });

  it("lists Opus 4.8 as the leading (preferred) claude model", () => {
    expect(modelsForAgent("claude")[0]?.id).toBe("claude-opus-4-8");
  });

  it("lists codex models", () => {
    const ids = modelsForAgent("codex").map((m) => m.id);
    expect(ids).toContain("gpt-5-codex");
  });

  it("tags every model with its agent", () => {
    for (const m of MODELS) {
      expect(["claude", "codex"]).toContain(m.agent);
    }
  });

  it("every model has a pricing entry in its agent's table", () => {
    for (const m of MODELS) {
      const table = m.agent === "codex" ? CODEX_PRICING : PRICING;
      expect(table[m.id], `missing price for ${m.id}`).toBeDefined();
    }
  });

  it("the default model is in the list", () => {
    expect(MODELS.some((m) => m.id === DEFAULT_MODEL)).toBe(true);
  });

  it("resolves a default model per agent", () => {
    expect(defaultModelForAgent("claude")).toBe("claude-opus-4-8");
    expect(modelsForAgent("codex").some((m) => m.id === defaultModelForAgent("codex"))).toBe(true);
  });
});
