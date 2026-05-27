import { DEFAULT_MODEL, MODELS } from "@/lib/models";
import { PRICING } from "@/lib/orchestrator/pricing";
import { describe, expect, it } from "vitest";

describe("models", () => {
  it("defaults to Claude Opus 4.7", () => {
    expect(DEFAULT_MODEL).toBe("claude-opus-4-7");
  });

  it("lists at least Opus, Sonnet, Haiku", () => {
    const ids = MODELS.map((m) => m.id);
    expect(ids).toContain("claude-opus-4-7");
    expect(ids).toContain("claude-sonnet-4-5");
    expect(ids).toContain("claude-haiku-4-5");
  });

  it("every model has a pricing entry", () => {
    for (const m of MODELS) {
      expect(PRICING[m.id], `missing price for ${m.id}`).toBeDefined();
    }
  });

  it("the default model is in the list", () => {
    expect(MODELS.some((m) => m.id === DEFAULT_MODEL)).toBe(true);
  });
});
