import { estimateCost, priceForModel } from "@/lib/orchestrator/pricing";
import { describe, expect, it } from "vitest";

describe("pricing", () => {
  it("knows Opus 4.7, Sonnet 4.5 and Haiku 4.5 rates", () => {
    expect(priceForModel("claude-opus-4-7")).toEqual({ inputPerMTok: 15, outputPerMTok: 75 });
    expect(priceForModel("claude-sonnet-4-5")).toEqual({ inputPerMTok: 3, outputPerMTok: 15 });
    expect(priceForModel("claude-haiku-4-5")).toEqual({ inputPerMTok: 1, outputPerMTok: 5 });
  });

  it("falls back to Sonnet for unknown models", () => {
    expect(priceForModel("mystery")).toEqual({ inputPerMTok: 3, outputPerMTok: 15 });
  });

  it("estimates cost from tokens", () => {
    // 1M input @ $3 + 1M output @ $15 = $18
    expect(estimateCost("claude-sonnet-4-5", 1_000_000, 1_000_000)).toBeCloseTo(18);
    // Haiku: 2M input @ $1 = $2
    expect(estimateCost("claude-haiku-4-5", 2_000_000, 0)).toBeCloseTo(2);
  });
});
