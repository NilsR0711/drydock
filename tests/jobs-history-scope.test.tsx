// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accessibleName } from "./fixtures/a11y";
import { type Rendered, render } from "./fixtures/react";

const push = vi.fn();
let currentSearch = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => "/jobs",
  useSearchParams: () => new URLSearchParams(currentSearch),
}));

import { JobsHistoryFilters } from "@/components/jobs-history-filters";

const PROPS = { repos: [], models: [] };

function scopeGroup(c: HTMLElement): HTMLElement {
  const g = c.querySelector<HTMLElement>('[role="radiogroup"][aria-label="Search scope"]');
  if (!g) throw new Error("scope radiogroup not found");
  return g;
}

function scopeRadio(c: HTMLElement, value: string): HTMLInputElement {
  const r = Array.from(
    scopeGroup(c).querySelectorAll<HTMLInputElement>('input[type="radio"]'),
  ).find((el) => el.value === value);
  if (!r) throw new Error(`scope radio "${value}" not found`);
  return r;
}

describe("JobsHistoryFilters — search scope (issue #409)", () => {
  let mounted: Rendered | undefined;

  beforeEach(() => {
    push.mockClear();
    currentSearch = "";
    window.history.replaceState(null, "", "/jobs");
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
  });

  it("exposes a labelled scope toggle with a logs option", () => {
    mounted = render(<JobsHistoryFilters {...PROPS} />);
    const { container } = mounted;
    expect(accessibleName(scopeGroup(container))).toBe("Search scope");
    expect(() => scopeRadio(container, "logs")).not.toThrow();
  });

  it("switches into the logs scope while preserving the term", () => {
    currentSearch = "q=ENOSPC";
    window.history.replaceState(null, "", "/jobs?q=ENOSPC");
    mounted = render(<JobsHistoryFilters {...PROPS} />);
    const logs = scopeRadio(mounted.container, "logs");

    act(() => {
      logs.click();
    });

    expect(push).toHaveBeenCalledTimes(1);
    const url = String(push.mock.calls[0]?.[0]);
    expect(url).toContain("scope=logs");
    expect(url).toContain("q=ENOSPC");
  });

  it("reflects the active logs scope in the search placeholder", () => {
    currentSearch = "scope=logs";
    mounted = render(<JobsHistoryFilters {...PROPS} />);
    const input = mounted.container.querySelector<HTMLInputElement>(
      'input[aria-label="Search jobs"]',
    );
    expect(input?.getAttribute("placeholder")).toMatch(/log/i);
  });

  it("keeps the issue-title placeholder in the default scope", () => {
    mounted = render(<JobsHistoryFilters {...PROPS} />);
    const input = mounted.container.querySelector<HTMLInputElement>(
      'input[aria-label="Search jobs"]',
    );
    expect(input?.getAttribute("placeholder")).toMatch(/title/i);
  });
});
