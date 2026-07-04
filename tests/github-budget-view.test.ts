import { describe, expect, it } from "vitest";
import { deriveGithubBudgetView, WARN_FRACTION } from "@/lib/github/budget-view";
import type { RateBudget } from "@/lib/github/rate-limit";

const RESET = 1_700_000_000;

function budget(partial: Partial<RateBudget>): RateBudget {
  return { remaining: 5000, limit: 5000, reset: RESET, gated: false, ...partial };
}

describe("deriveGithubBudgetView", () => {
  it("is unknown when no resource has been observed", () => {
    const view = deriveGithubBudgetView({ core: null, graphql: null });
    expect(view.state).toBe("unknown");
    expect(view.tone).toBe("neutral");
    expect(view.remainingPercent).toBeNull();
    expect(view.resources).toEqual([]);
    expect(view.gated).toBe(false);
  });

  it("is ok with a healthy budget and reports the lowest remaining percent", () => {
    const view = deriveGithubBudgetView({
      core: budget({ remaining: 4000, limit: 5000 }), // 80%
      graphql: budget({ remaining: 4500, limit: 5000 }), // 90%
    });
    expect(view.state).toBe("ok");
    expect(view.tone).toBe("success");
    expect(view.remainingPercent).toBe(80);
    expect(view.label).toContain("80%");
    expect(view.resources).toHaveLength(2);
  });

  it("warns when a budget is low but not yet gating sweeps", () => {
    // 40% remaining: below the warn fraction, above the reserve so not gated.
    expect(WARN_FRACTION).toBeGreaterThan(0.3);
    const view = deriveGithubBudgetView({
      core: budget({ remaining: 2000, limit: 5000, gated: false }), // 40%
      graphql: null,
    });
    expect(view.state).toBe("warning");
    expect(view.tone).toBe("warning");
    expect(view.remainingPercent).toBe(40);
  });

  it("reports the sweeps-deferred state when any resource is gated", () => {
    const view = deriveGithubBudgetView({
      core: budget({ remaining: 1000, limit: 5000, gated: true }), // 20%, gated
      graphql: budget({ remaining: 4500, limit: 5000, gated: false }), // 90%
    });
    expect(view.state).toBe("gated");
    expect(view.tone).toBe("destructive");
    expect(view.gated).toBe(true);
    expect(view.label).toMatch(/sweeps deferred/i);
  });

  it("builds labelled, toned per-resource rows", () => {
    const view = deriveGithubBudgetView({
      core: budget({ remaining: 1000, limit: 5000, gated: true }),
      graphql: budget({ remaining: 4500, limit: 5000, gated: false }),
    });
    const core = view.resources.find((r) => r.resource === "core");
    const graphql = view.resources.find((r) => r.resource === "graphql");
    expect(core).toMatchObject({ label: "REST", remainingPercent: 20, tone: "destructive" });
    expect(graphql).toMatchObject({ label: "GraphQL", remainingPercent: 90, tone: "success" });
  });

  it("picks the soonest reset among gated resources for the countdown", () => {
    const view = deriveGithubBudgetView({
      core: budget({ remaining: 1000, limit: 5000, gated: true, reset: RESET + 100 }),
      graphql: budget({ remaining: 500, limit: 5000, gated: true, reset: RESET + 10 }),
    });
    expect(view.resetsAt).toBe(RESET + 10);
  });

  it("treats a zero limit as full rather than dividing by zero", () => {
    const view = deriveGithubBudgetView({
      core: budget({ remaining: 0, limit: 0, gated: false }),
      graphql: null,
    });
    expect(view.state).toBe("ok");
    expect(view.remainingPercent).toBe(100);
  });
});
