// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { GithubBudgetCard, GithubBudgetPill } from "@/components/github-budget";
import { deriveGithubBudgetView } from "@/lib/github/budget-view";
import { type Rendered, render } from "./fixtures/react";

let mounted: Rendered | undefined;

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

/** A reset an hour out so the countdown is always live. */
const reset = Math.floor(Date.now() / 1000) + 3600;

describe("GithubBudgetPill (issue #408)", () => {
  it("renders an unknown state when nothing has been observed", () => {
    mounted = render(
      <GithubBudgetPill view={deriveGithubBudgetView({ core: null, graphql: null })} />,
    );
    expect(mounted.container.textContent ?? "").toContain("GitHub");
  });

  it("shows the sweeps-deferred state when a resource is gated", () => {
    const view = deriveGithubBudgetView({
      core: { remaining: 1000, limit: 5000, reset, gated: true },
      graphql: null,
    });
    mounted = render(<GithubBudgetPill view={view} />);
    expect(mounted.container.textContent ?? "").toMatch(/deferred/i);
  });

  it("shows the remaining percent when healthy", () => {
    const view = deriveGithubBudgetView({
      core: { remaining: 4000, limit: 5000, reset, gated: false },
      graphql: null,
    });
    mounted = render(<GithubBudgetPill view={view} />);
    expect(mounted.container.textContent ?? "").toContain("80%");
  });
});

describe("GithubBudgetCard (issue #408)", () => {
  it("degrades gracefully to 'no reading yet' when unknown", () => {
    mounted = render(
      <GithubBudgetCard view={deriveGithubBudgetView({ core: null, graphql: null })} />,
    );
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("GitHub API budget");
    expect(text).toMatch(/no reading yet/i);
  });

  it("renders per-resource rows and the deferred banner when gated", () => {
    const view = deriveGithubBudgetView({
      core: { remaining: 1000, limit: 5000, reset, gated: true }, // 20%, gated
      graphql: { remaining: 4000, limit: 5000, reset, gated: false }, // 80%
    });
    mounted = render(<GithubBudgetCard view={view} />);
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("REST");
    expect(text).toContain("GraphQL");
    expect(text).toMatch(/sweeps deferred/i);
  });
});
