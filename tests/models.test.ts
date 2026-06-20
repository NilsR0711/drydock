import { describe, expect, it } from "vitest";
import { CODEX_PRICING } from "@/lib/agents/codex";
import {
  DEFAULT_MODEL,
  defaultModelForAgent,
  MODELS,
  modelsForAgent,
  nextStrongerModel,
} from "@/lib/models";
import { PRICING } from "@/lib/orchestrator/pricing";

describe("models", () => {
  it("defaults to Claude Opus 4.8", () => {
    expect(DEFAULT_MODEL).toBe("claude-opus-4-8");
  });

  it("lists at least Fable 5, Opus 4.8, Opus 4.7, Sonnet 4.6, Sonnet 4.5, Haiku for claude", () => {
    const ids = modelsForAgent("claude").map((m) => m.id);
    expect(ids).toContain("claude-fable-5");
    expect(ids).toContain("claude-opus-4-8");
    expect(ids).toContain("claude-opus-4-7");
    expect(ids).toContain("claude-sonnet-4-6");
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

describe("nextStrongerModel", () => {
  it("escalates one rung up the claude ladder", () => {
    expect(nextStrongerModel("claude", "claude-haiku-4-5")).toBe("claude-sonnet-4-5");
    expect(nextStrongerModel("claude", "claude-sonnet-4-5")).toBe("claude-sonnet-4-6");
    expect(nextStrongerModel("claude", "claude-sonnet-4-6")).toBe("claude-opus-4-7");
  });

  it("escalates one rung up the codex ladder", () => {
    expect(nextStrongerModel("codex", "gpt-5-mini")).toBe("gpt-5");
    expect(nextStrongerModel("codex", "gpt-5")).toBe("gpt-5-codex");
  });

  it("caps at the strongest model of the agent", () => {
    expect(nextStrongerModel("claude", "claude-opus-4-8")).toBeNull();
    expect(nextStrongerModel("codex", "gpt-5-codex")).toBeNull();
  });

  it("returns null for a model the agent does not list", () => {
    // A codex id on a claude job (or vice versa) has no defined rung.
    expect(nextStrongerModel("claude", "gpt-5-mini")).toBeNull();
    expect(nextStrongerModel("codex", "claude-haiku-4-5")).toBeNull();
    expect(nextStrongerModel("claude", "totally-unknown")).toBeNull();
  });

  it("returns null without a current model", () => {
    expect(nextStrongerModel("claude", null)).toBeNull();
    expect(nextStrongerModel("claude", undefined)).toBeNull();
    expect(nextStrongerModel("claude", "")).toBeNull();
  });

  it("returns null for opencode (no static ladder to rank, issue #349)", () => {
    expect(
      nextStrongerModel("opencode", "openrouter/meta-llama/llama-3.3-70b-instruct:free"),
    ).toBeNull();
  });
});
