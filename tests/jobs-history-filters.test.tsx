// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accessibleName, required } from "./fixtures/a11y";
import { type Rendered, render } from "./fixtures/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/jobs",
  useSearchParams: () => new URLSearchParams(""),
}));

import { JobsHistoryFilters } from "@/components/jobs-history-filters";

const PROPS = {
  repos: [
    { id: 1, name: "acme/web" },
    { id: 2, name: "acme/api" },
  ],
  models: [
    { id: "claude-opus-4-8", label: "Opus 4.8" },
    { id: "claude-sonnet-5", label: "Sonnet 5" },
  ],
};

/** The select whose option list includes the given placeholder option text. */
function selectWithOption(c: ParentNode, optionText: string): HTMLSelectElement {
  const el = [...c.querySelectorAll<HTMLSelectElement>("select")].find((s) =>
    [...s.options].some((o) => o.textContent === optionText),
  );
  if (!el) throw new Error(`select containing option "${optionText}" not found`);
  return el;
}

describe("JobsHistoryFilters accessible names (issue #401)", () => {
  let mounted: Rendered | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
  });

  it("names the search Input beyond its placeholder", () => {
    mounted = render(<JobsHistoryFilters {...PROPS} />);
    // Scope past the status SegmentedControl's radio inputs (issue #400) to the
    // text search box this test is about.
    const el = required(
      mounted.container.querySelector<HTMLInputElement>('input:not([type="radio"])'),
      "search input",
    );
    const name = accessibleName(el);
    expect(name).toBe("Search jobs");
    expect(name).not.toBe(el.getAttribute("placeholder"));
  });

  it("names the repository filter Select", () => {
    mounted = render(<JobsHistoryFilters {...PROPS} />);
    const el = selectWithOption(mounted.container, "All repositories");
    expect(accessibleName(el)).toBe("Filter by repository");
  });

  it("names the model filter Select", () => {
    mounted = render(<JobsHistoryFilters {...PROPS} />);
    const el = selectWithOption(mounted.container, "All models");
    expect(accessibleName(el)).toBe("Filter by model");
  });
});
