import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CODEX_MAX_PRICE, CODEX_PRICING, codexPriceForModel } from "@/lib/agents/codex";
import { estimateCost, MAX_PRICE, PRICING, priceForModel } from "@/lib/orchestrator/pricing";

describe("pricing", () => {
  it("knows Opus 4.8, Opus 4.7, Sonnet 4.5 and Haiku 4.5 rates", () => {
    expect(priceForModel("claude-opus-4-8")).toEqual({ inputPerMTok: 5, outputPerMTok: 25 });
    expect(priceForModel("claude-opus-4-7")).toEqual({ inputPerMTok: 15, outputPerMTok: 75 });
    expect(priceForModel("claude-sonnet-4-5")).toEqual({ inputPerMTok: 3, outputPerMTok: 15 });
    expect(priceForModel("claude-haiku-4-5")).toEqual({ inputPerMTok: 1, outputPerMTok: 5 });
  });

  it("estimates cost from tokens", () => {
    // 1M input @ $3 + 1M output @ $15 = $18
    expect(estimateCost("claude-sonnet-4-5", 1_000_000, 1_000_000)).toBeCloseTo(18);
    // Haiku: 2M input @ $1 = $2
    expect(estimateCost("claude-haiku-4-5", 2_000_000, 0)).toBeCloseTo(2);
  });

  describe("unknown model id handling (fail-safe for budgeting)", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
      warnSpy.mockRestore();
    });

    it("emits a warning for an unknown claude model id", () => {
      priceForModel("claude-mystery-99");
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0]?.[0]).toMatch(/unknown.*model/i);
    });

    it("returns the most expensive known claude price for an unknown id (fail-safe)", () => {
      const price = priceForModel("claude-mystery-99");
      const maxOutput = Math.max(...Object.values(PRICING).map((p) => p.outputPerMTok));
      expect(price.outputPerMTok).toBe(maxOutput);
      expect(price).toEqual(MAX_PRICE);
    });

    it("does not warn for null (unset model — unambiguous, not a typo)", () => {
      priceForModel(null);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("does not warn for undefined (unset model)", () => {
      priceForModel(undefined);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("returns the most expensive price for null/undefined (fail-safe for budgeting)", () => {
      expect(priceForModel(null)).toEqual(MAX_PRICE);
      expect(priceForModel(undefined)).toEqual(MAX_PRICE);
    });
  });

  describe("MAX_PRICE", () => {
    it("is the most expensive entry in PRICING by output token rate", () => {
      const maxOutput = Math.max(...Object.values(PRICING).map((p) => p.outputPerMTok));
      expect(MAX_PRICE.outputPerMTok).toBe(maxOutput);
    });
  });
});

describe("codex pricing", () => {
  it("knows gpt-5-codex, gpt-5 and gpt-5-mini rates", () => {
    expect(codexPriceForModel("gpt-5-codex")).toEqual({ inputPerMTok: 1.25, outputPerMTok: 10 });
    expect(codexPriceForModel("gpt-5")).toEqual({ inputPerMTok: 1.25, outputPerMTok: 10 });
    expect(codexPriceForModel("gpt-5-mini")).toEqual({ inputPerMTok: 0.25, outputPerMTok: 2 });
  });

  describe("unknown model id handling (fail-safe for budgeting)", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
      warnSpy.mockRestore();
    });

    it("emits a warning for an unknown codex model id", () => {
      codexPriceForModel("gpt-unknown-xyz");
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0]?.[0]).toMatch(/unknown.*model/i);
    });

    it("returns the most expensive known codex price for an unknown id (fail-safe)", () => {
      const price = codexPriceForModel("gpt-unknown-xyz");
      const maxOutput = Math.max(...Object.values(CODEX_PRICING).map((p) => p.outputPerMTok));
      expect(price.outputPerMTok).toBe(maxOutput);
      expect(price).toEqual(CODEX_MAX_PRICE);
    });

    it("does not warn for null or undefined", () => {
      codexPriceForModel(null);
      codexPriceForModel(undefined);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("returns the most expensive price for null/undefined", () => {
      expect(codexPriceForModel(null)).toEqual(CODEX_MAX_PRICE);
      expect(codexPriceForModel(undefined)).toEqual(CODEX_MAX_PRICE);
    });
  });

  describe("CODEX_MAX_PRICE", () => {
    it("is the most expensive entry in CODEX_PRICING by output token rate", () => {
      const maxOutput = Math.max(...Object.values(CODEX_PRICING).map((p) => p.outputPerMTok));
      expect(CODEX_MAX_PRICE.outputPerMTok).toBe(maxOutput);
    });
  });
});
