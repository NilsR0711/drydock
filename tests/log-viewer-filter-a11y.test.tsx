// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fire, type Rendered, render } from "./fixtures/react";

// The log rows render inside react-virtuoso, which needs real layout metrics
// jsdom lacks. The filter UI under test lives in the header/panel, outside the
// virtualized list, so stub the list to keep the mount focused and stable.
vi.mock("react-virtuoso", () => ({ Virtuoso: () => null }));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));

import { LogViewer } from "@/components/log-viewer";

function click(el: Element): void {
  fire(el, new MouseEvent("click", { bubbles: true }));
}

function filterButton(c: HTMLElement): HTMLButtonElement {
  const btn = Array.from(c.querySelectorAll("button")).find((b) =>
    /Filter/.test(b.textContent ?? ""),
  );
  if (!btn) throw new Error("Filter disclosure button not found");
  return btn;
}

function chips(c: HTMLElement): HTMLButtonElement[] {
  const panel = c.querySelector<HTMLElement>(".dd-fade-up");
  if (!panel) throw new Error("filter panel not open");
  return Array.from(panel.querySelectorAll<HTMLButtonElement>("button[aria-pressed]"));
}

describe("LogViewer filter a11y (issue #400)", () => {
  let mounted: Rendered | undefined;

  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
  });

  it("marks the Filter disclosure button collapsed until it is opened", () => {
    mounted = render(
      <LogViewer jobId={1} active={false} initial={[{ id: 1, type: "text", payload: "hi" }]} />,
    );
    const btn = filterButton(mounted.container);
    expect(btn.getAttribute("aria-expanded")).toBe("false");

    click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
  });

  it("exposes each event-type chip's visibility as aria-pressed and toggles it", () => {
    mounted = render(
      <LogViewer jobId={1} active={false} initial={[{ id: 1, type: "text", payload: "hi" }]} />,
    );
    click(filterButton(mounted.container));

    const initialChips = chips(mounted.container);
    expect(initialChips.length).toBeGreaterThan(0);
    // Nothing hidden yet: every event type is visible → pressed.
    expect(initialChips.every((b) => b.getAttribute("aria-pressed") === "true")).toBe(true);

    const first = initialChips[0];
    if (!first) throw new Error("no event-type chip rendered");
    click(first);
    // Re-query: hiding a type re-renders the panel.
    expect(chips(mounted.container)[0]?.getAttribute("aria-pressed")).toBe("false");
  });
});
