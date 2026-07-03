// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Dialog } from "@/components/ui/dialog";
import { type Rendered, render } from "./fixtures/react";

/** Advance timers inside act so the exit-transition state updates flush. */
function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

// Mirrors the production shape (IssueDetailModal -> ConfirmDialog): an inner
// Dialog rendered inside an outer Dialog's children, so the inner root wrapper
// is a *descendant* of the outer panel, not a sibling.
function NestedHarness({ outerOpen, innerOpen }: { outerOpen: boolean; innerOpen: boolean }) {
  return (
    <div>
      <button type="button" id="page-trigger">
        open outer
      </button>
      <Dialog open={outerOpen} onClose={() => {}} title="Outer">
        <button type="button" id="outer-btn">
          do thing
        </button>
        <Dialog open={innerOpen} onClose={() => {}} title="Inner">
          <button type="button" id="inner-btn">
            confirm
          </button>
        </Dialog>
      </Dialog>
    </div>
  );
}

function isInert(el: Element | null | undefined): boolean {
  return !!el?.hasAttribute("inert");
}

describe("Nested Dialog (inner rendered inside outer's children)", () => {
  let r: Rendered | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    r?.unmount();
    r = undefined;
    vi.useRealTimers();
    document.body.innerHTML = "";
    document.body.removeAttribute("style");
  });

  test("the active (inner) dialog stays interactive while open", () => {
    r = render(<NestedHarness outerOpen={true} innerOpen={true} />);
    const innerBtn = r.container.querySelector("#inner-btn");
    const panels = r.container.querySelectorAll('[role="dialog"]');
    // Two dialogs mounted; the inner panel (last) must not be inert.
    const innerPanel = panels[panels.length - 1];
    expect(isInert(innerPanel)).toBe(false);
    expect(isInert(innerBtn)).toBe(false);
  });

  test("the outer dialog is fully restored after the inner one closes", () => {
    r = render(<NestedHarness outerOpen={true} innerOpen={true} />);
    const outerBtn = r.container.querySelector("#outer-btn");
    const outerClose = r.container.querySelector('[aria-label="Close"]');
    // While the inner dialog is open the outer content is blocked (nested-modal
    // semantics) — that's expected. The critical invariant is that it comes back.
    r.rerender(<NestedHarness outerOpen={true} innerOpen={false} />);
    // Advance past the inner dialog's exit transition + unmount.
    advance(250);

    expect(isInert(outerBtn)).toBe(false);
    expect(outerBtn?.getAttribute("aria-hidden")).toBeNull();
    expect(isInert(outerClose)).toBe(false);
    expect(outerClose?.getAttribute("aria-hidden")).toBeNull();
    // Outer still open -> body still locked, page trigger still hidden.
    expect(document.body.style.overflow).toBe("hidden");
    expect(isInert(r?.container.querySelector("#page-trigger"))).toBe(true);
  });

  test("everything is restored once both dialogs close", () => {
    r = render(<NestedHarness outerOpen={true} innerOpen={true} />);
    r.rerender(<NestedHarness outerOpen={true} innerOpen={false} />);
    advance(250);
    r.rerender(<NestedHarness outerOpen={false} innerOpen={false} />);
    advance(250);

    const pageTrigger = r.container.querySelector("#page-trigger");
    expect(isInert(pageTrigger)).toBe(false);
    expect(pageTrigger?.getAttribute("aria-hidden")).toBeNull();
    expect(document.body.style.overflow).toBe("");
  });
});
