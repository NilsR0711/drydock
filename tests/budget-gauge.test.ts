import { describe, expect, it } from "vitest";
import { budgetRatio } from "@/components/ui/budget-gauge";

describe("budgetRatio", () => {
  it("returns the spend/limit ratio", () => {
    expect(budgetRatio(5, 10)).toBe(0.5);
  });

  it("clamps to 1 when spend exceeds the limit", () => {
    expect(budgetRatio(15, 10)).toBe(1);
  });

  it("returns 0 when the limit is 0 (allowed by the settings schema)", () => {
    expect(budgetRatio(0, 0)).toBe(0);
    expect(budgetRatio(5, 0)).toBe(0);
  });

  it("returns 0 for a negative limit", () => {
    expect(budgetRatio(5, -1)).toBe(0);
  });

  it("never yields NaN or Infinity for the SVG stroke math", () => {
    expect(Number.isFinite(budgetRatio(0, 0))).toBe(true);
    expect(Number.isFinite(budgetRatio(1, 0))).toBe(true);
  });
});
