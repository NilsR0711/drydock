// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { accessibleName } from "./fixtures/a11y";
import { type Rendered, render, setInputValue } from "./fixtures/react";

// The log rows render inside react-virtuoso, which needs layout metrics jsdom
// lacks. The find input and empty-state live outside the virtualized list, so
// stub the list to keep the mount focused and stable.
vi.mock("react-virtuoso", () => ({ Virtuoso: () => null }));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));

import { LogViewer } from "@/components/log-viewer";

function findInput(c: HTMLElement): HTMLInputElement {
  const el = c.querySelector<HTMLInputElement>('input[aria-label="Find in log"]');
  if (!el) throw new Error("find-in-log input not found");
  return el;
}

describe("LogViewer find-in-log (issue #409)", () => {
  let mounted: Rendered | undefined;

  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
  });

  it("exposes a find input with an accessible name", () => {
    mounted = render(
      <LogViewer jobId={1} active={false} initial={[{ id: 1, type: "text", payload: "hi" }]} />,
    );
    expect(accessibleName(findInput(mounted.container))).toBe("Find in log");
  });

  it("shows a no-matches message when the query filters every line out", () => {
    mounted = render(
      <LogViewer
        jobId={1}
        active={false}
        initial={[{ id: 1, type: "text", payload: "all good" }]}
      />,
    );
    // Nothing filtered yet — no empty-state message.
    expect(mounted.container.textContent).not.toContain("No log lines match");

    setInputValue(findInput(mounted.container), "zzz-nope");
    expect(mounted.container.textContent).toContain("No log lines match");
    expect(mounted.container.textContent).toContain("zzz-nope");
  });

  it("reveals a clear button once a query is entered", () => {
    mounted = render(
      <LogViewer jobId={1} active={false} initial={[{ id: 1, type: "text", payload: "hi" }]} />,
    );
    const clear = () =>
      mounted?.container.querySelector<HTMLButtonElement>('button[aria-label="Clear find"]');
    expect(clear()).toBeNull();

    setInputValue(findInput(mounted.container), "hi");
    expect(clear()).not.toBeNull();
  });
});
