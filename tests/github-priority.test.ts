import { describe, expect, it } from "vitest";
import { currentPriority, withPriority } from "@/lib/github/priority";

describe("request priority scope", () => {
  it("defaults to high outside any scope", () => {
    expect(currentPriority()).toBe("high");
  });

  it("reports the active priority inside a scope", () => {
    const seen = withPriority("low", () => currentPriority());
    expect(seen).toBe("low");
  });

  it("restores the outer priority after the scope ends", () => {
    withPriority("low", () => {
      expect(currentPriority()).toBe("low");
    });
    expect(currentPriority()).toBe("high");
  });

  it("preserves the scope across async boundaries", async () => {
    const seen = await withPriority("low", async () => {
      await Promise.resolve();
      return currentPriority();
    });
    expect(seen).toBe("low");
  });

  it("nests scopes and restores the parent on exit", () => {
    withPriority("low", () => {
      expect(currentPriority()).toBe("low");
      withPriority("high", () => {
        expect(currentPriority()).toBe("high");
      });
      expect(currentPriority()).toBe("low");
    });
  });

  it("returns the callback's value", () => {
    expect(withPriority("low", () => 42)).toBe(42);
  });
});
