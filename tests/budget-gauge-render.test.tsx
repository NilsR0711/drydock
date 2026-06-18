// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { BudgetGauge, BudgetMeter } from "@/components/ui/budget-gauge";
import { type Rendered, render } from "./fixtures/react";

let mounted: Rendered | undefined;

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

describe("BudgetGauge unlimited state (issue #234)", () => {
  it("shows an unlimited state instead of 'of $0 limit' when the limit is 0", () => {
    mounted = render(<BudgetGauge value={5} limit={0} />);
    const text = mounted.container.textContent ?? "";
    expect(text).toMatch(/unlimited/i);
    expect(text).not.toContain("of $0 limit");
  });

  it("still renders the dollar ceiling when a positive limit is set", () => {
    mounted = render(<BudgetGauge value={5} limit={10} />);
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("of $10 limit");
    expect(text).not.toMatch(/unlimited/i);
  });
});

describe("BudgetMeter unlimited state (issue #234)", () => {
  it("shows an unlimited state instead of '/ $0.00' when the limit is 0", () => {
    mounted = render(<BudgetMeter value={5} limit={0} />);
    const text = mounted.container.textContent ?? "";
    expect(text).toMatch(/unlimited/i);
    expect(text).not.toContain("/ $0.00");
  });

  it("still renders the dollar ceiling and percentage when a positive limit is set", () => {
    mounted = render(<BudgetMeter value={5} limit={10} />);
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("/ $10.00");
    expect(text).toContain("50%");
  });
});
